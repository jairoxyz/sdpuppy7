import puppeteer from 'rebrowser-puppeteer-core';
import { Launcher } from 'chrome-launcher';

const USER_AGENT =
  process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

export async function getSrc(embedUrl, referer, timeoutMs = 10_000) {
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

  // Intercept all requests before navigation starts
  await page.setRequestInterception(true);

  let settled = false;
  let hopped = false; // whether we already promoted the iframe to top-level
  let finish;
  const finalPromise = new Promise((r) => (finish = r));

  const deadline = Date.now() + timeoutMs;
  const timeLeft = () => Math.max(0, deadline - Date.now());

  page.on('request', (req) => {
    const url = req.url();
    const type = req.resourceType();
    console.log('[REQ]', type, url);

    // 1) Resolve on first .m3u8 anywhere
    if (!settled && url.includes('.m3u8')) {
      settled = true;
      try { req.continue(); } catch {}
      finish(url);
      return;
    }

    // 2) Detect first iframe document navigation and "promote" it
    //    to a top-level navigation with correct referer. We abort
    //    the iframe's own document request to avoid double loading.
    const frame = req.frame();
    const isIframeDoc =
      req.isNavigationRequest() &&
      type === 'document' &&
      frame &&
      frame.parentFrame(); // not null => it's a child frame

    if (!settled && !hopped && isIframeDoc) {
      hopped = true;
      const childUrl = url;
      const parentUrl = page.url();

      // Abort the iframe document request: we will navigate top-level instead.
      try { req.abort(); } catch {}

      // Trigger top-level navigation to the iframe URL with referer=parent
      (async () => {
        try {
          await page.goto(childUrl, {
            waitUntil: 'domcontentloaded',
            referer: parentUrl,
            timeout: timeLeft(),
          });
        } catch {
          // swallow; timer or m3u8 will resolve
        }
      })();

      return;
    }

    // 3) Let most things pass; block only heavy assets if you want
    if (type === 'image' || type === 'font') {
      try { req.abort(); } catch {}
    } else {
      try { req.continue(); } catch {}
    }
  });

  try {
    // Initial navigation with the provided referer
    await page.goto(embedUrl, {
      waitUntil: 'domcontentloaded',
      referer,
      timeout: timeLeft(),
    }).catch(() => { /* rely on timeout and network listener */ });

    // Wait for .m3u8 or timeout
    const result = await Promise.race([
      finalPromise,
      new Promise((r) => setTimeout(() => r(null), timeLeft())),
    ]);

    return { src: result || null };
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

// Demo
async function main() {
  const x = await getSrc(
    'https://embedsports.top/embed/admin/ppv-vf-b-stuttgart-vs-sc-freiburg/1',
    'https://streamed.pk/',
    15000
  );
  console.log(x);
}
main();