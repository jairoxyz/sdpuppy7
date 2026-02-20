// h2-hls-fetch.mjs
import { connect as h2connect } from 'node:http2';
import * as zlib from 'node:zlib';

function decodeBody(buf, encoding) {
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
    if (enc.includes('deflate')) return zlib.inflateSync(buf).toString('utf8');
  } catch {
    // fall through
  }
  return buf.toString('utf8');
}

/**
 * Fetch an HLS playlist over HTTP/2.
 * @param {string} url
 * @param {Record<string,string>} extraHeaders lowercase keys (e.g., { cookie: '...' })
 * @param {number} timeoutMs
 */
export async function getHlsOverH2(url, extraHeaders = {}, timeoutMs = 15000) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('This H2 client expects an https URL');

  const hostname = u.hostname;
  const authority = hostname; // IMPORTANT: browsers set hostname only here

  // Start conservative: avoid “browser-only” headers unless needed.
  // You can add them back incrementally if required.
  const h2headers = {
    ':method': 'GET',
    ':scheme': 'https',
    ':authority': authority,
    ':path': u.pathname + u.search,

    // Keep these simple and sane
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9',

    'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': 'Windows',

    // These two often matter for hotlink/CORS checks
    'origin': 'https://embedsports.top',
    'referer': 'https://embedsports.top/jwp/8.38.10/provider.hlsjs.js',

    // UA that looks like Chrome, but avoid sending sec-ch-ua* unless your TLS matches Chrome
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',

    // Merge any caller-provided headers (lowercase keys)
    ...extraHeaders,
  };

  return new Promise((resolve, reject) => {
    const client = h2connect(`https://${authority}`, {
      // Let Node negotiate TLS 1.2/1.3 like a browser; don’t pin to 1.2
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      servername: hostname,                 // SNI like browsers
      ALPNProtocols: ['h2', 'http/1.1'],    // Prefer h2
      // You can also set ciphers/EC curves if you need closer Chrome parity
      ecdhCurve: 'X25519:P-256:P-384:P-521',
    });

    const timer = setTimeout(() => {
      client.destroy(new Error(`Timeout after ${timeoutMs} ms`));
    }, timeoutMs);

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const req = client.request(h2headers, { endStream: true });

    let status = 0;
    let resHeaders = {};
    const chunks = [];

    req.on('response', (headers) => {
      resHeaders = headers;
      status = parseInt(headers[':status'] || '0', 10);
    });

    req.on('data', (chunk) => chunks.push(chunk));

    req.on('end', () => {
      clearTimeout(timer);
      client.close();
      const buf = Buffer.concat(chunks);
      const text = decodeBody(buf, resHeaders['content-encoding']);
      resolve({
        status,
        headers: resHeaders,
        body: text,
        finalUrl: url,
        http2: true,
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      client.close();
      reject(err);
    });

    req.end();
  });
}



async function getHLS() {
  const url = "http://localhost:4000/get?url=https://embedsports.top/embed/echo/mens-t20-world-cup-england-vs-italy-cricket-hundred-1/1&referer=https://streamed.pk";

  const res = await fetch(url, { method: "GET" });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  // If you expect text:
  // const body = await res.text();
  // console.log(body);

  // If you expect JSON, use:
  const data = await res.json();
  //console.log(data);
  return data.src
}

const src = await getHLS();
console.log(src);


// Example usage with top-level await:
const r = await getHlsOverH2(src);
console.log(r.status);
console.log(r.body.slice(0, 300));
