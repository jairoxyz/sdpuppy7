import puppeteer from 'rebrowser-puppeteer-core';
import { Launcher } from 'chrome-launcher';

const USER_AGENT =
  process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

/**
 * Collect exactly two requests whose URL contains `matchSubstring` and return
 * their URL + request headers, in the order they were made.
 *
 * @param {string} embedUrl
 * @param {string} referer
 * @param {string} matchSubstring e.g., "/hezushon/"
 * @param {number} timeoutMs overall timeout
 * @returns {Promise<{ records: Array<{ url: string, requestHeaders: Record<string,string> }>, timedOut: boolean }>}
 */
export async function getUris(
  embedUrl,
  referer,
  matchSubstring = '/hezushon/',
  timeoutMs = 10_000
) {
  const installations = await Launcher.getInstallations();
  if (!installations.length) throw new Error('No Chrome found');
  const chromePath = installations[0];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--mute-audio',
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  // Ensure sub-requests also carry the referer when possible
  if (referer) {
    await page.setExtraHTTPHeaders({ referer });
  }

  // Intercept to access request headers and to prune trivial assets
  await page.setRequestInterception(true);

  const records = [];
  let resolved = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const finishIfReady = () => {
    if (!resolved && records.length >= 2) {
      resolved = true;
      resolveDone();
    }
  };

  page.on('request', (req) => {
    const url = req.url();
    console.log('[REQ]', req.resourceType(), url);
    if (url.includes(matchSubstring)) {
      records.push({
        url,
        requestHeaders: req.headers(), // header names are lowercased by Puppeteer
      });
      finishIfReady();
    }

    // Abort trivial assets to speed up discovery
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'stylesheet') {
      try { req.abort(); } catch {}
    } else {
      try { req.continue(); } catch {}
    }
  });

  const deadline = Date.now() + timeoutMs;
  const timeLeft = () => Math.max(0, deadline - Date.now());

  try {
    await page.goto(embedUrl, {
      waitUntil: 'domcontentloaded',
      referer,
      timeout: timeLeft(),
    }).catch(() => { /* ignore; timer below governs */ });

    // Wait either until we have 2 matches or we time out
    await Promise.race([
      done,
      new Promise((r) => setTimeout(r, timeLeft())),
    ]);

    return {
      records,                // up to 2 items, in call order
      timedOut: !resolved,    // true if we didn't reach 2 before timeout
    };
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

// Example usage
async function main() {
  const result = await getUris(
        'https://vidcore.net/tv/224941/1/1',
    'https://vidcore.net/',
    '/hezushon/',
    15000
  );
  console.log(JSON.stringify(result, null, 2));
}

main();