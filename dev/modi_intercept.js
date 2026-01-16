
import puppeteer from 'rebrowser-puppeteer-core';
import { Launcher } from 'chrome-launcher';
import Xvfb from 'xvfb';

const USER_AGENT =
  process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

async function getModiUrl(embedUrl, referer) {
  let xvfbsession;

  // Start Xvfb on Linux for non-headless Chromium
  if (process.platform === 'linux') {
    try {
      xvfbsession = new Xvfb({
        silent: true,
        xvfb_args: ['-screen', '0', '1920x1080x24', '-ac'],
      });
      xvfbsession.startSync();
    } catch (err) {
      console.error('Xvfb start error:', err.message);
    }
  }

  const viewport = {
    deviceScaleFactor: 1,
    hasTouch: false,
    height: 1080,
    isLandscape: true,
    isMobile: false,
    width: 1920,
  };

  // Choose a Chrome installation
  const installations = await Launcher.getInstallations();
  if (!installations || installations.length === 0) {
    throw new Error('No Chrome installations found by chrome-launcher.');
  }
  const chromePath = installations[0];

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4,AutomationControlled',
    '--mute-audio',
  ];

  const browser = await puppeteer.launch({
    args,
    defaultViewport: viewport,
    executablePath: chromePath,
    headless: process.platform === 'linux' ? false : true, // Xvfb on linux -> headful
  });

  // Stop Xvfb when browser disconnects
  browser.on('disconnected', () => {
    try {
      if (xvfbsession) xvfbsession.stopSync();
    } catch (err) {
      console.error('Failed to stop Xvfb:', err);
    }
  });

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({
    Referer: referer, // <-- fixed (was using undefined "referer" vs "eferer")
  });

  // We’ll turn interception on, listen, and resolve when we see ".m3u8"
  await page.setRequestInterception(true);

  const timeoutMs = 30_000;

  const result = await new Promise(async (resolve) => {
    let settled = false;
    let timer;

    const finish = async (value) => {
      if (settled) return;
      settled = true;

      try {
        page.off('request', onRequest);
      } catch {}
      try {
        await page.setRequestInterception(false);
      } catch {}

      clearTimeout(timer);

      // Close page & browser to let Node exit cleanly
      try {
        await page.close({ runBeforeUnload: true });
      } catch {}
      try {
        await browser.close();
      } catch {}

      resolve(value);
    };

    const onRequest = (request) => {
      const reqUrl = request.url();
      // Always continue the request to avoid stalling the page
      request.continue().catch(() => {});

      // Log if you want to debug:
      console.log(reqUrl);

      if (reqUrl.includes('.m3u8')) {
        // Resolve with the matching URL
        finish(reqUrl);
      }
    };

    page.on('request', onRequest);

    // Safety timeout
    timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    // Navigate (use domcontentloaded to avoid "never idle" pages)
    try {
      await page.goto(embedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    } catch (err) {
      // If navigation fails, end now
      finish(null);
    }
  });

  return result; // string (.m3u8 URL) or null
}

export { getModiUrl };

// Example usage (top-level await in ESM):
const mist = await getModiUrl(
  'https://modistreams.org/embed/seriea/2026-01-11/int-nap',
  'https://ppv.to/'
);
console.log('Matched .m3u8 URL:', mist);
