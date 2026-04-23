import dns from 'node:dns';
import { URL } from 'node:url';
import puppeteer from 'rebrowser-puppeteer-core';
import { Launcher } from 'chrome-launcher';

dns.setDefaultResultOrder('ipv4first');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Resolve the /gaizda/ API call by intercepting it inside Chromium.
 * No fetch(), no external replay.
 */
export async function resolveGaizda(embedUrl, {
  timeoutMs = 20000,
  ua = DEFAULT_UA,
  matchSubstr = '/gaizda/',
  headless = true,           // set false if site requires visible browser
  extraHeaders = {},         // optional: e.g. { 'Accept-Language': 'en-US,en;q=0.9' }
  referer = '',              // optional referer for initial navigation
} = {}) {
  if (!embedUrl) throw new Error('embedUrl is required');
  const embedHost = new URL(embedUrl).host;

  const installs = await Launcher.getInstallations();
  if (!installs.length) throw new Error('No Chrome installation found');
  const chromePath = installs[0];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless,
    turnstile: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,720',
    ],
    defaultViewport: { width: 1280, height: 720 },
  });

  const ctx = await browser.createBrowserContext?.() ?? browser.defaultBrowserContext();
  const page = await ctx.newPage();

  await page.setUserAgent(ua);
  if (extraHeaders && Object.keys(extraHeaders).length) {
    await page.setExtraHTTPHeaders(extraHeaders);
  }

  // Optional: block noisy resources (keeps navigation fast)
  await page.setRequestInterception(true);
  page.on('request', req => {
    try {
      const u = req.url();
      if (u.startsWith('data:') || u.startsWith('chrome:') || u.startsWith('chrome-extension:')) {
        return req.abort();
      }
      const type = req.resourceType();
      console.log("[REQ]", u, type)
      if (type === 'image' || type === 'font') return req.abort();
      return req.continue();
    } catch {
      try { req.continue(); } catch {}
    }
  });

  // CDP session for real interception + reading response body
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');

  // Intercept both Request and Response stages for URLs containing /gaizda/
  await cdp.send('Fetch.enable', {
    patterns: [
      {
        urlPattern: `*${matchSubstr}*`,
        requestStage: 'Request',
      },
      {
        urlPattern: `*${matchSubstr}*`,
        requestStage: 'Response',
      },
    ],
  });

  let doneResolve;
  const done = new Promise(r => { doneResolve = r; });

  // store request info until the response arrives
  const seen = new Map(); // requestId -> requestInfo

  cdp.on('Fetch.requestPaused', async (evt) => {
    const { requestId, request, responseStatusCode, responseHeaders } = evt;

    try {
      const url = request?.url || '';
      if (!url.includes(matchSubstr)) {
        await cdp.send('Fetch.continueRequest', { requestId });
        return;
      }

      // Stage: Request
      if (responseStatusCode == null) {
        seen.set(requestId, {
          url,
          method: request.method,
          headers: request.headers || {},
          postData: request.postData ?? null,
        });

        await cdp.send('Fetch.continueRequest', { requestId });
        return;
      }

      // Stage: Response (we can read the body here)
      const reqInfo = seen.get(requestId) || {
        url,
        method: request.method,
        headers: request.headers || {},
        postData: request.postData ?? null,
      };

      let body = null;
      try {
        body = await cdp.send('Fetch.getResponseBody', { requestId });
        // body: { body: string, base64Encoded: boolean }
      } catch (e) {
        // Sometimes body isn't available (e.g. streaming); still continue.
        body = null;
      }

      const out = {
        match: matchSubstr,
        embed: { url: embedUrl, host: embedHost },
        request: {
          url: reqInfo.url,
          method: reqInfo.method,
          headers: reqInfo.headers,
          body: reqInfo.postData,
        },
        response: {
          status: responseStatusCode,
          headers: responseHeaders || [],
          // Keep raw body for downstream; decode preview for debugging.
          bodyBase64: body?.base64Encoded ? body.body : Buffer.from(body?.body || '', 'utf8').toString('base64'),
          base64Encoded: true,
          previewText: (() => {
            if (!body) return null;
            const buf = body.base64Encoded
              ? Buffer.from(body.body, 'base64')
              : Buffer.from(body.body, 'utf8');
            // show a small preview (avoid huge output)
            return buf.toString('utf8').slice(0, 400);
          })(),
        },
        ts: Date.now(),
      };

      // Continue request before resolving (avoid deadlocks)
      await cdp.send('Fetch.continueRequest', { requestId });

      // Resolve only once (first /gaizda/ response)
      if (doneResolve) {
        doneResolve(out);
        doneResolve = null;
      }
    } catch (err) {
      try { await cdp.send('Fetch.continueRequest', { requestId }); } catch {}
      // Don't crash; just keep waiting
    }
  });

  // Navigate (this triggers the site’s own JS → makes the /gaizda/ request)
  await page.goto(embedUrl, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
    ...(referer ? { referer } : {}),
  }).catch(() => {});

  // Wait until we captured the response or timeout
  const result = await Promise.race([
    done,
    (async () => { await sleep(timeoutMs); return null; })(),
  ]);

  // Cleanup
  try { await page.close(); } catch {}
  try { await ctx.close?.(); } catch {}
  try { await browser.close(); } catch {}

  if (!result) throw new Error(`Timed out waiting for ${matchSubstr} request`);
  return result;
}

// CLI usage: node resolve-gaizda.mjs "https://vidfast.pro/..."
if (process.argv[1] && process.argv[1].endsWith('test3.js') && process.argv[2]) {
  const embedUrl = process.argv[2];
  resolveGaizda(embedUrl, {
    headless: process.platform !== 'linux', // often better non-headless on linux w/ xvfb
    extraHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    referer: 'https://vidfast.pro/',
  }).then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => {
    console.error(String(e?.message || e));
    process.exit(1);
  });
}