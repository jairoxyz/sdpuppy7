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

  // Intercept to both speed up and capture .m3u8 early
  await page.setRequestInterception(true);

  let resolveFinal;
  const finalPromise = new Promise((r) => (resolveFinal = r));
  let settled = false;

  // Detect .m3u8 anywhere
  page.on('request', (req) => {
    const url = req.url();
    // console.log('[REQ]', req.resourceType(), url);

    if (!settled && url.includes('.m3u8')) {
      settled = true;
      try { req.continue(); } catch {}
      resolveFinal(url);
      return;
    }

    // Block only trivial asset types (keep media/xhr/script/etc.!)
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
    // 1) Go to the initial embed with the initial referer
    await page.goto(embedUrl, {
      waitUntil: 'domcontentloaded',
      referer,
      timeout: timeLeft(),
    }).catch(() => { /* swallow; timer below governs */ });

    if (settled) {
      // Already saw the manifest via early network requests
      const src = await Promise.race([finalPromise, new Promise(r => setTimeout(() => r(null), 1))]);
      return { src };
    }

    //  Wait until either we see the .m3u8 or we time out
    const winner = await Promise.race([
      finalPromise,
      new Promise((r) => setTimeout(() => r(null), timeLeft())),
    ]);

    return { src: winner || null };
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

// async function main() {
//   const x = await getSrc(
//     //'https://embedsports.top/embed/admin/ppv-vf-b-stuttgart-vs-sc-freiburg/1'
//     'https://embedsports.top/embed/echo/farmers-insurance-open-pga-tour-tgl-001/1',
//     'https://streamed.pk/',
//     15000
//   );
//   console.log(x);
// }

// main();