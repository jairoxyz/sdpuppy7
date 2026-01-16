
import puppeteer from 'rebrowser-puppeteer-core';
import { Launcher } from 'chrome-launcher';

const USER_AGENT =
  process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

/**
 * Navigates to `embedUrl` and returns the first request URL that contains `.m3u8`.
 *
 * @param {string} embedUrl - Embed page URL.
 * @param {string} referer  - Referer header value to send.
 * @param {number} timeoutMs - Overall timeout for matching, default 30s.
 * @returns {Promise<string|null>} - The matched .m3u8 URL or null if not found.
 */

export async function getSrc(embedUrl, referer, timeoutMs = 10_000) {

  const installations = await Launcher.getInstallations();
  if (!installations || installations.length === 0) {
    throw new Error('No Chrome/Chromium installations found by chrome-launcher.');
  }
  const chromePath = installations[0];


  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--mute-audio',
      // Optional: minimize extra features (tune as you like)
      '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4,AutomationControlled',
    ],
    defaultViewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      isLandscape: true,
    },
  });

  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ Referer: referer });

  // Promise that resolves on first .m3u8 request (no interception needed)
  const m3u8Promise = new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(null);
      }
    }, timeoutMs);

    const onRequest = (req) => {
      const url = req.url();
      //console.log(url); // uncomment to debug
      if (!settled && url.includes('.m3u8')) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(url);
      }
    };

    function cleanup() {
      try { page.off('request', onRequest); } catch {}
    }

    page.on('request', onRequest);

    // Navigate (avoid relying solely on networkidle for highly dynamic pages)
    page.goto(embedUrl, {
      waitUntil: 'domcontentloaded', // player init usually starts after DOM ready
      timeout: timeoutMs,
    }).catch(() => {
      // If navigation throws (timeout, etc.), we still let the timer decide
    });
  });

  try {
    const m3u8Url = await m3u8Promise;
    return {"src": m3u8Url} ?? {};
  } finally {
    // Ensure clean shutdown so Node exits (no Ctrl+C needed)
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}


