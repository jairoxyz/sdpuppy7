import puppeteer from 'rebrowser-puppeteer-core';
import { Launcher } from 'chrome-launcher';
import crypto from 'crypto';

const TARGET_URL = 'https://vidcore.net/tv/224941/1/1';
const USER_AGENT =
  process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';


//--------------------------------------------
// MAIN
//--------------------------------------------
(async () => {

  const installations = await Launcher.getInstallations();
  if (!installations.length) throw new Error('No Chrome found');
  const chromePath = installations[0];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
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

  
  await page.setRequestInterception(true);

  page.on('request', req => {
    const urlStr = req.url();
    if (urlStr.startsWith('data:') ||

          urlStr.includes('google') ||
          urlStr.includes('podley') ||
          urlStr.includes('wsrv.nl') ||
          urlStr.includes('unwrapsstow')
        ) {
        return req.abort();
      }
    req.continue();
  });

  // === Capture POST responses ===
  page.on('response', async (res) => {
    try {
      const url = res.url();
      const req = res.request();
      console.log(`[${req.method()}] ${url}`);
      if (req.method() === 'POST') {
        const text = await res.text();

        // Look for base64 or m3u8
        if (text.includes('m3u8')) {
          console.log('\n✅ POSSIBLE M3U8:\n', text);
        }

        // Often encrypted responses look like base64
        if (/^[A-Za-z0-9+/=]+$/.test(text.substring(0, 100))) {
          console.log('\n📦 Encrypted payload detected:', url);
        }
      }

    } catch (e) {}
  });

  // === Load page ===
  await page.goto('https://vidcore.net/tv/224941/1/1', {
    waitUntil: 'networkidle2'
  });

  // === Wait for webpack + player init ===
 await new Promise(resolve => setTimeout(resolve, 30000));

  // ✅ Try extracting directly from player context
  const m3u8 = await page.evaluate(() => {
    try {
      // Common locations
      if (window?.player?.source?.url) return window.player.source.url;
      if (window?.hls?.url) return window.hls.url;

      // Scan globals for m3u8
      for (const key of Object.keys(window)) {
        try {
          const val = window[key];
          if (typeof val === 'string' && val.includes('.m3u8')) {
            return val;
          }
        } catch {}
      }

      return null;
    } catch (e) {
      return null;
    }
  });

  console.log('\n🎯 Extracted m3u8:', m3u8);

  // === Advanced: hook fetch/XHR BEFORE requests ===
  // (use if above didn't catch final request)
  /*
  await page.evaluate(() => {
    const origFetch = window.fetch;

    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      const clone = res.clone();

      clone.text().then(t => {
        if (t.includes('.m3u8')) {
          console.log("M3U8 FOUND:", t);
        }
      });

      return res;
    };
  });
  */

})();
