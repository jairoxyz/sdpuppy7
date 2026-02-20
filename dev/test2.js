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

  // ---- Response capture state ----
  let settled = false;
  let firstM3U8Url = null;

  let resolveFinal;
  let rejectFinal;
  const finalPromise = new Promise((r, j) => { resolveFinal = r; rejectFinal = j; });

  // Capture the FIRST .m3u8 response body (no fetch; straight from network)
  page.on('response', async (res) => {
    if (settled) return;

    try {
      const url = res.url();
      const lowerUrl = url.toLowerCase();
      const ct = (res.headers()['content-type'] || '').toLowerCase();

      const looksLikeM3U8 =
        lowerUrl.includes('.m3u8') ||
        ct.includes('application/vnd.apple.mpegurl') ||
        ct.includes('application/x-mpegurl');

      // If we already saw the request URL, prefer matching that; otherwise accept any first .m3u8
      const matchesTarget = firstM3U8Url
        ? url === firstM3U8Url || lowerUrl.includes('.m3u8')
        : looksLikeM3U8;

      if (!matchesTarget) return;

      const text = await res.text(); // Chrome auto-decompresses (gzip/br)
      settled = true;

      // Log URL then content (as requested)
      //console.log(url);
      //console.log(text);

      resolveFinal({ src: url, content: text, status: res.status(), headers: res.headers() });
    } catch (e) {
      // Even if reading fails, resolve with URL only
      if (!settled) {
        settled = true;
        resolveFinal({ src: firstM3U8Url, content: null, error: String(e) });
      }
    }
  });

  // Intercept to both speed up and detect .m3u8 early (no body here)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    const type = req.resourceType();
    // console.log('[REQ]', type, url);
    if (!settled && url.includes('.m3u8') && !firstM3U8Url) {
      firstM3U8Url = url; // remember; the response listener will read its body
      try { req.continue(); } catch {}
      return;
    }

    // Block only trivial asset types (keep media/xhr/script/etc.)
    if (type === 'image' || type === 'font' || type === 'stylesheet') {
      try { req.abort(); } catch {}
    } else {
      try { req.continue(); } catch {}
    }
  });

  // Request failures (surface if it was the target)
  page.on('requestfailed', (req) => {
    if (settled) return;
    const url = req.url();
    if (url.includes('.m3u8')) {
      settled = true;
      resolveFinal({ src: url, content: null, error: req.failure()?.errorText || 'request failed' });
    }
  });

  // Page-level errors
  const errHandler = (err) => { if (!settled) { settled = true; rejectFinal(err); } };
  page.on('error', errHandler);
  page.on('pageerror', errHandler);

  const deadline = Date.now() + timeoutMs;
  const timeLeft = () => Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      resolveFinal({ src: firstM3U8Url, content: null, error: 'timeout' });
    }
  }, timeLeft());

  try {
    // 1) Go to the initial embed with the initial referer
    await page.goto(embedUrl, {
      waitUntil: 'domcontentloaded',
      referer,
      timeout: timeLeft(),
    }).catch(() => { /* swallow; timeout guard handles it */ });

    // 2) Wait until either we saw & read the .m3u8 response or we time out
    const result = await finalPromise;

    return { src: result?.src || null, content: result?.content || null };
  } finally {
    clearTimeout(timer);
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}


(async () => {
  try {
    const x = await getSrc(
      // 'https://embedsports.top/embed/admin/ppv-vf-b-stuttgart-vs-sc-freiburg/1',
      'https://embedsports.top/embed/echo/mens-t20-world-cup-australia-vs-sri-lanka-cricket-1/1',
      'https://streamed.pk/',
      15000
    );
    console.log(JSON.stringify(x));
  } catch (err) {
    console.error('getSrc failed:', err);
    process.exitCode = 1;
  }
})();

