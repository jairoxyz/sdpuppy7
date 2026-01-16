
// run-function.js

const TOKEN = '2TmFaI0a6pwi3AU30449e0744da2a3f6ec8cbde71f4631dee';
const BASE = 'https://production-lon.browserless.io'; // or production-lon / production-ams
const EMBED_URL = 'https://modistreams.org/embed/seriea/2026-01-11/int-nap';
const REFERER = 'https://ppv.to/';
const TIMEOUT_MS = 45000;


// This code runs on Browserless (managed Chrome). No Puppeteer in your project.

const remoteCode = `
export default async function ({ page }) {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ Referer: '${REFERER}' });

  const timeoutMs = ${TIMEOUT_MS};
  const allRequests = [];

  const hostFilter = (url) =>
    url.includes('.m3u8') &&
    (url.includes('strm.poocloud.in') || url.includes('/secure/'));

  const waitForFirst = async () => {
    const reqP  = page.waitForRequest(r => hostFilter(r.url()), { timeout: timeoutMs }).catch(() => null);
    const respP = page.waitForResponse(r => hostFilter(r.url()) && r.status() === 200, { timeout: timeoutMs }).catch(() => null);
    const winner = await Promise.race([reqP, respP]);
    if (!winner) return null;
    return typeof winner.url === 'function' ? winner.url() : (winner.request ? winner.request().url() : null);
  };

  // Collect ALL requests
  const onRequest = (req) => {
    try { allRequests.push(req.url()); } catch {}
  };
  page.on('request', onRequest);

  try {
    await page.goto('${EMBED_URL}', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (_) {}

  const m3u8 = await waitForFirst();

  // Clean up listener
  try { page.off('request', onRequest); } catch {}

  return {
    type: 'application/json',
    data: { m3u8, allRequests }
  };
}
`;

async function main() {
  if (!TOKEN) throw new Error('Set BROWSERLESS_TOKEN');
  const url = `${BASE}/function?token=${encodeURIComponent(TOKEN)}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/javascript' },
    body: remoteCode,
  });
  if (!r.ok) throw new Error(`/function failed: ${r.status} ${r.statusText} — ${await r.text()}`);

  const json = await r.json();
  console.log('Matched .m3u8:', json?.m3u8 ?? json?.data?.m3u8 ?? null);
  console.log('allRequests count:', json?.data?.allRequests?.length ?? 0);
  console.log('allRequests:', json?.data?.allRequests ?? []);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

