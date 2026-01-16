
/**
 * HLS playlist-only proxy (single-variant) with headers via URL params
 *
 * - Proxies ONLY the playlist (.m3u8), not segments
 * - Absolutizes relative URIs (segment lines and KEY/MAP URI attributes)
 * - Conditional GET support (If-None-Match / If-Modified-Since -> 304)
 * - Upstream headers can be provided as URL params (override env & client headers)
 *
 * Requirements:
 *   Node.js 18+ (uses global fetch)
 *   npm i express
 *
 * Usage example:
 *   node server.js
 *   http://localhost:3999/playlist?url=https%3A%2F%2Fcdn.example.com%2Fpath%2Findex.m3u8
 *
 * Passing headers via URL params:
 *   ...&ua=Mozilla%2F5.0%20(...)&referer=https%3A%2F%2Fexample.com%2F&origin=https%3A%2F%2Fexample.com
 *   ...&cookie=sessionid%3Dabc123%3B%20other%3Dval
 *   ...&authorization=Bearer%20TOKEN
 *   ...&h_x_foo=bar  (-> X-Foo: bar)
 */

import express from 'express';
import http from 'http';
import dns from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';

// Force IP4
dns.setDefaultResultOrder('ipv4first');

// Force TLS 1.2 (min = max) to avoid 403 response
// Cipher list focused on TLS 1.2 ciphers that are broadly supported and include the negotiated one
const TLS12_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256', // <-- negotiated by your probe
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305'
].join(':');

const tls12Agent = new Agent({
  allowH2: true, // H2 is fine in your case
  connect: {
    tls: {
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],
      ciphers: TLS12_CIPHERS,
      honorCipherOrder: true
    }
  }
});

setGlobalDispatcher(tls12Agent);

// ---- Config ----
const PORT = process.env.PROXY_PORT || 3999;

// Environment default headers (lowest precedence)
const ENV_DEFAULT_HEADERS = {
  'User-Agent': process.env.UPSTREAM_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    // process.env.UPSTREAM_UA || (
    //     process.platform === 'linux'
    //     ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    //     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    // ),
  Referer: process.env.UPSTREAM_REFERER || '',
  Origin: process.env.UPSTREAM_ORIGIN || '',
  Accept: process.env.UPSTREAM_ACCEPT || '*/*',
  'Accept-Language': process.env.UPSTREAM_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
  // Keep playlist responses simple; add br/gzip if you know the client can handle it.
  //'Accept-Encoding': process.env.UPSTREAM_ACCEPT_ENCODING || 'identity',
  Connection: 'keep-alive',
  ...(process.env.UPSTREAM_COOKIE ? { Cookie: process.env.UPSTREAM_COOKIE } : {}),
};

// Optional allowlist for upstream hosts (safety)
const ALLOWLIST =
  (process.env.ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// ---- Helpers ----
function isAbsoluteUrl(u = '') {
  return /^https?:\/\//i.test(u);
}
function toAbsolute(base, rel) {
  return new URL(rel, base).toString();
}
function absolutizeKeyOrMapUri(line, baseUrl) {
  // For #EXT-X-KEY / #EXT-X-MAP lines: absolutize URI="..."
  const m = line.match(/URI=\"([^\"]+)\"/i);
  if (m && m[1]) {
    const current = m[1];
    if (!isAbsoluteUrl(current)) {
      const abs = toAbsolute(baseUrl, current);
      return line.replace(m[0], `URI="${abs}"`);
    }
  }
  return line;
}
function isMasterPlaylist(lines) {
  // Master playlists contain #EXT-X-STREAM-INF or #EXT-X-MEDIA
  return lines.some(
    (ln) => ln.startsWith('#EXT-X-STREAM-INF') || ln.startsWith('#EXT-X-MEDIA')
  );
}

/**
 * Build upstream headers with precedence:
 *   URL params > client request headers > env defaults
 * You can pass arbitrary headers via URL params with prefix "h_".
 */
function buildUpstreamHeaders(req) {
  const urlParams = req.query || {};

  // Start from env defaults
   const h = { ...ENV_DEFAULT_HEADERS };

  // Finally, URL params (highest precedence)
  // Short convenience params:
  // ua, referer, origin, cookie, accept, accept_language, accept_encoding, authorization
  if (urlParams.ua) h['User-Agent'] = urlParams.ua;
  if (urlParams.referer) h['Referer'] = urlParams.referer;
  if (urlParams.origin) h['Origin'] = urlParams.origin;
  if (urlParams.cookie) h['Cookie'] = urlParams.cookie;
  if (urlParams.accept) h['Accept'] = urlParams.accept;
  if (urlParams.accept_language) h['Accept-Language'] = urlParams.accept_language;
  if (urlParams.accept_encoding) h['Accept-Encoding'] = urlParams.accept_encoding;
  if (urlParams.authorization) h['Authorization'] = urlParams.authorization;

  // Arbitrary headers via h_<name>=value  (e.g., h_x_foo=bar -> X-Foo: bar)
  // We transform h_header_name into a proper header name:
  // - strip "h_" prefix
  // - replace underscores with hyphens
  // - title-case words (X-Custom-Header)
  for (const [key, val] of Object.entries(urlParams)) {
    if (!key.toLowerCase().startsWith('h_')) continue;
    const raw = key.slice(2); // remove 'h_'
    if (!raw) continue;
    const headerName = raw
      .split('_')
      .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
      .join('-');
    if (val != null && val !== '') {
      h[headerName] = String(val);
    }
  }

  
  // Conditional GET support controlled by client (safe to accept):
  if (urlParams.if_none_match)      h['If-None-Match']     = urlParams.if_none_match;
  if (urlParams.if_modified_since)  h['If-Modified-Since'] = urlParams.if_modified_since;


  return h;
}

// ---- App ----
const app = express();

// Health check
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Playlist proxy (single-variant only; no segment proxy)
app.get('/playlist', async (req, res) => {
  try {
    const playlistUrl = req.query.url;
    if (!playlistUrl) {
      res.status(400).send('Missing query param: url');
      return;
    }

    // Optional upstream host allowlist
    if (ALLOWLIST.length > 0) {
      const host = new URL(playlistUrl).host;
      if (!ALLOWLIST.includes(host)) {
        res.status(403).send('Origin not allowed by proxy');
        return;
      }
    }

    const upstreamHeaders = buildUpstreamHeaders(req);
    console.log(`Upstream headers: ${JSON.stringify(upstreamHeaders)}`);

    const r = await fetch(playlistUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: upstreamHeaders,
      dispatcher: tls12Agent,
    });

    // Conditional response passthrough
    if (r.status === 304) {
      res.status(304);
      const etag = r.headers.get('etag');
      const lm = r.headers.get('last-modified');
      if (etag) res.set('ETag', etag);
      if (lm) res.set('Last-Modified', lm);
      res.set('Cache-Control', 'no-store, must-revalidate');
      res.end();
      return;
    }

    if (!r.ok) {
      res.status(r.status);
      const txt = await r.text().catch(() => '');
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(`Upstream returned ${r.status}\n${txt}`);
      return;
    }

    const baseUrl = r.url; // after redirects
    const text = await r.text();
    const lines = text.split(/\r?\n/);

    if (!text.trimStart().startsWith('#EXTM3U')) {
      res.set('X-Warning', 'Upstream response does not start with #EXTM3U');
    }
    if (isMasterPlaylist(lines)) {
      res.set('X-Notice', 'Master playlist detected; this proxy is single-variant only.');
      // You may still return the content; many players require proper master rewriting to work.
    }

    // Absolutize segment lines + KEY/MAP URIs
    const out = [];
    for (const line of lines) {
      if (!line || line.startsWith('#')) {
        if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
          out.push(absolutizeKeyOrMapUri(line, baseUrl));
        } else {
          out.push(line);
        }
      } else {
        out.push(isAbsoluteUrl(line) ? line : toAbsolute(baseUrl, line));
      }
    }

    // Validators so clients can do conditional GET next time
    const etag = r.headers.get('etag');
    const lm = r.headers.get('last-modified');
    if (etag) res.set('ETag', etag);
    if (lm) res.set('Last-Modified', lm);

    res.status(200);
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.set('Cache-Control', 'no-store, must-revalidate');
    // res.set('Pragma', 'no-cache'); // optional extra
    res.send(out.join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).send(
      'Proxy error: ' + (err && err.message ? err.message : String(err))
    );
  }
});

// ---- Start ----
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`SD proxy listening on port ${PORT}`);
});
