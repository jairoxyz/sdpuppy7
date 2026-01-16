
import express from 'express';
import http from 'http';
import https from 'https';
import dns from 'node:dns';
import { URL } from 'node:url';

// Force IPv4 (helps resolve to same edge consistently across OSes)
dns.setDefaultResultOrder('ipv4first');

// ---- Config ----
const PORT = process.env.PROXY_PORT || 3999;

// Environment default headers (lowest precedence)
const ENV_DEFAULT_HEADERS = {
  // Choose a stable UA; override with ?ua=... or UPSTREAM_UA
  'User-Agent': process.env.UPSTREAM_UA || //'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    process.env.UPSTREAM_UA || (
        process.platform === 'linux'
        ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    ),
  Referer: process.env.UPSTREAM_REFERER || '',
  Origin: process.env.UPSTREAM_ORIGIN || '',

  // A slightly more specific Accept that still matches browsers and HLS
  Accept: process.env.UPSTREAM_ACCEPT || 'application/vnd.apple.mpegurl,*/*;q=0.9',

  'Accept-Language': process.env.UPSTREAM_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',

  // Keep upstream body uncompressed to avoid needing to decompress
  'Accept-Encoding': process.env.UPSTREAM_ACCEPT_ENCODING || 'identity',

  // DO NOT set 'Connection' or other hop-by-hop headers here (we strip them anyway)

  ...(process.env.UPSTREAM_COOKIE ? { Cookie: process.env.UPSTREAM_COOKIE } : {}),
};

// Optional allowlist for upstream hosts (safety)
const ALLOWLIST = (process.env.ALLOWLIST || '')
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
 * Arbitrary headers via query `h_<name>=value` (underscores -> hyphens, title-cased words).
 */
function buildUpstreamHeaders(req) {
  const urlParams = req.query || {};

  // Start from env defaults
  const h = { ...ENV_DEFAULT_HEADERS };

  // URL param convenience keys (highest precedence)
  if (urlParams.ua) h['User-Agent'] = urlParams.ua;
  if (urlParams.referer) h['Referer'] = urlParams.referer;
  if (urlParams.origin) h['Origin'] = urlParams.origin;
  if (urlParams.cookie) h['Cookie'] = urlParams.cookie;
  if (urlParams.accept) h['Accept'] = urlParams.accept;
  if (urlParams.accept_language) h['Accept-Language'] = urlParams.accept_language;
  if (urlParams.accept_encoding) h['Accept-Encoding'] = urlParams.accept_encoding;
  if (urlParams.authorization) h['Authorization'] = urlParams.authorization;

  // Arbitrary headers via h_<name>=value
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

  // Conditional GET support (client-driven)
  if (urlParams.if_none_match) h['If-None-Match'] = urlParams.if_none_match;
  if (urlParams.if_modified_since) h['If-Modified-Since'] = urlParams.if_modified_since;

  return h;
}

/**
 * Remove hop-by-hop headers and ones the agent/stack should set.
 * (Safer even though we're using HTTP/1.1.)
 */
function sanitizeH1Headers(h = {}) {
  const out = { ...h };
  const forbidden = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'upgrade',
    'transfer-encoding',
    'host', // host/authority derived from URL
  ];
  for (const k of [...forbidden, ...forbidden.map((x) => x.toUpperCase())]) {
    delete out[k];
  }
  return out;
}

/**
 * Node fetch seems to be detected and tls1.3 blocked by upstream server, so use
 * core HTTPS GET with HTTP/1.1 + TLS 1.2, following redirects.
 * Returns { status, headers (object), body (string), finalUrl (string) }
 */
async function getH1Tls12(url, headers = {}, maxRedirects = 5, timeoutMs = 15000) {
  let current = new URL(url);
  let redirects = 0;

  const doOnce = (u) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: 'GET',
          servername: u.hostname, // SNI
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
          headers: sanitizeH1Headers(headers),
          // You can add 'ca' here if you ever need custom CA roots
        },
        (res) => {
          const { statusCode = 0, headers: resHeaders = {} } = res;

          // Handle redirects
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            const loc = resHeaders.location;
            res.resume(); // discard body
            if (!loc) {
              resolve({
                status: statusCode,
                headers: resHeaders,
                body: '',
                finalUrl: u.toString(),
              });
              return;
            }
            resolve({
              redirect: new URL(loc, u).toString(),
              status: statusCode,
              headers: resHeaders,
            });
            return;
          }

          // Collect body as text (playlist is text; we keep identity encoding by default)
          res.setEncoding('utf8');
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () =>
            resolve({
              status: statusCode,
              headers: resHeaders,
              body,
              finalUrl: u.toString(),
            })
          );
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Upstream request timeout after ${timeoutMs} ms`));
      });
      req.on('error', reject);
      req.end();
    });

  while (redirects <= maxRedirects) {
    const r = await doOnce(current);
    if (r.redirect) {
      redirects += 1;
      current = new URL(r.redirect);
      continue;
    }
    return r;
  }
  throw new Error(`Too many redirects (${maxRedirects})`);
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

    // Build and log upstream headers (for debugging)
    const upstreamHeaders = buildUpstreamHeaders(req);
    //console.log(`Upstream headers: ${JSON.stringify(upstreamHeaders)}`);

    // Perform upstream request using core HTTPS (HTTP/1.1 + TLS 1.2)
    const r = await getH1Tls12(playlistUrl, {
      ...upstreamHeaders,
      // Ensure predictable identity encoding by default
      'Accept-Encoding': upstreamHeaders['Accept-Encoding'] || 'identity',
    });

    // Conditional response passthrough
    if (r.status === 304) {
      res.status(304);
      const etag = r.headers['etag'];
      const lm = r.headers['last-modified'];
      if (etag) res.set('ETag', etag);
      if (lm) res.set('Last-Modified', lm);
      res.set('Cache-Control', 'no-store, must-revalidate');
      res.end();
      return;
    }

    // Non-2xx upstream -> relay status and body
    if (r.status < 200 || r.status >= 300) {
      res.status(r.status || 502);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(`Upstream returned ${r.status}\n${r.body || ''}`);
      return;
    }

    const baseUrl = r.finalUrl || playlistUrl; // after redirects
    const text = r.body || '';
    const lines = text.split(/\r?\n/);

    if (!text.trimStart().startsWith('#EXTM3U')) {
      res.set('X-Warning', 'Upstream response does not start with #EXTM3U');
    }
    if (isMasterPlaylist(lines)) {
      res.set(
        'X-Notice',
        'Master playlist detected; this proxy is single-variant only.'
      );
      // Returning it anyway; many players require proper master rewriting to work.
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
    const etag = r.headers['etag'];
    const lm = r.headers['last-modified'];
    if (etag) res.set('ETag', etag);
    if (lm) res.set('Last-Modified', lm);

    res.status(200);
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.set('Cache-Control', 'no-store, must-revalidate');
    // res.set('Pragma', 'no-cache'); // optional
    res.send(out.join('\n'));
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send('Proxy error: ' + (err && err.message ? err.message : String(err)));
  }
});

// ---- Start ----
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`SD proxy listening on port ${PORT}`);
});
