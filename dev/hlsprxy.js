// server.mjs
import express from 'express';
import http from 'http';
import dns from 'node:dns';
import { URL } from 'node:url';
import crypto from 'node:crypto';

import puppeteer from 'rebrowser-puppeteer-core';
import { Launcher } from 'chrome-launcher';

// --- Networking defaults ---
dns.setDefaultResultOrder('ipv4first');

// --- Config ---
const PORT = process.env.PROXY_PORT || 3999;

// Stable UA; override with ?ua=...
const DEFAULT_UA =
  process.env.UPSTREAM_UA ||
  (process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');

// Optional allowlist (safety)
const ALLOWLIST = (process.env.ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- Allowed embed + network hosts (match subdomains too) ---
const ALLOWED_HOSTS = new Set([
  'streamed.pk',
  'embedsports.top',
  'strmd.top',
  'poocloud.in',
]);

function hostMatchesAllowed(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const base of ALLOWED_HOSTS) {
    const b = base.toLowerCase();
    if (h === b || h.endsWith('.' + b)) return true;
  }
  return false;
}

// ------------- Helpers -------------
function isAbsoluteUrl(u = '') { return /^https?:\/\//i.test(u); }
function toAbsolute(base, rel) { return new URL(rel, base).toString(); }

function absolutizeKeyOrMapUri(line, baseUrl) {
  const m = line.match(/URI="([^"]+)"/i);
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
  return lines.some(ln => ln.startsWith('#EXT-X-STREAM-INF') || ln.startsWith('#EXT-X-MEDIA'));
}

/** Build the canonical sid URL for a playlist we want the player to use */
function buildSidPlaylistUrl(req, absoluteTargetUrl, sid) {
  const params = new URLSearchParams();
  params.set('url', absoluteTargetUrl);
  params.set('sid', sid);

  // Forward useful params that influence upstream behavior (optional)
  // + forward idle settings through redirect so the player keeps them
  const q = req.query || {};
  const forwardList = [
    'ua','referer','origin','accept','accept_language','accept_encoding','authorization',
    'idle','idle_ms', // ✅ NEW: per-session idle timeout forwarded through 302
  ];

  for (const k of forwardList) {
    const v = q[k];
    if (v != null && v !== '') params.set(k, String(v));
  }
  for (const [k, v] of Object.entries(q)) {
    if (k.toLowerCase().startsWith('h_') && v != null && v !== '') {
      params.set(k, String(v));
    }
  }
  return `${req.protocol}://${req.get('host')}/playlist?${params.toString()}`;
}

/** Rewrite MASTER playlists to point variant/media playlists back to this proxy with the same sid.
 *  TS segments are NOT rewritten.
 */
function rewriteMasterPlaylist(lines, baseUrl, req, sid) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA')) {
      const m = line.match(/URI="([^"]+)"/i);
      if (m && m[1]) {
        const current = m[1];
        const abs = isAbsoluteUrl(current) ? current : toAbsolute(baseUrl, current);
        const proxied = buildSidPlaylistUrl(req, abs, sid);
        out.push(line.replace(m[0], `URI="${proxied}"`));
        continue;
      }
      out.push(line);
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      out.push(line);
      const nextLine = lines[i + 1] || '';
      if (!nextLine || nextLine.startsWith('#')) continue;
      const absVariant = isAbsoluteUrl(nextLine) ? nextLine : toAbsolute(baseUrl, nextLine);
      const proxied = buildSidPlaylistUrl(req, absVariant, sid);
      out.push(proxied);
      i++;
      continue;
    }

    out.push(line);
  }
  return out;
}

// ------------- Session Store (single page per sid) -------------
const SESSIONS = new Map();  // sid -> session

// Session and browser cleanup
const SESSION_TTL_MS  = 3 * 60 * 60 * 1000; // 3 hours total time to live

// ✅ Default idle timeout is 2 minutes (your requirement)
const DEFAULT_IDLE_MS = 2 * 60 * 1000;      // 2 min since last /playlist(sid=...) access

// Clamp to avoid abuse / accidental extremes
const MIN_IDLE_MS = 15 * 1000;              // 15 seconds
const MAX_IDLE_MS = 30 * 60 * 1000;         // 30 minutes

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Parse per-session idle timeout from request query:
 * - idle_ms=<milliseconds> has priority
 * - idle=<seconds> is also supported
 * - returns DEFAULT_IDLE_MS if not provided or invalid
 */
function parseIdleMs(req) {
  const q = req.query || {};

  if (q.idle_ms != null && q.idle_ms !== '') {
    const ms = Number(q.idle_ms);
    if (Number.isFinite(ms) && ms > 0) return clamp(ms, MIN_IDLE_MS, MAX_IDLE_MS);
  }

  if (q.idle != null && q.idle !== '') {
    const sec = Number(q.idle);
    if (Number.isFinite(sec) && sec > 0) return clamp(sec * 1000, MIN_IDLE_MS, MAX_IDLE_MS);
  }

  return DEFAULT_IDLE_MS;
}

function nowMs() { return Date.now(); }
function newSid() { return crypto.randomUUID(); }

// ------------- Browser Manager -------------
class BrowserManager {
  constructor() {
    this.browser = null;
    this.chromePath = null;
  }
  async ensureBrowser() {
    if (this.browser) return this.browser;
    const installs = await Launcher.getInstallations();
    if (!installs.length) throw new Error('No Chrome found');
    this.chromePath = installs[0];

    this.browser = await puppeteer.launch({
      executablePath: this.chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--mute-audio',
      ],
      defaultViewport: { width: 1280, height: 720 },
    });
    return this.browser;
  }
  async newContext() {
    const browser = await this.ensureBrowser();
    if (typeof browser.createIncognitoBrowserContext === 'function') {
      return await browser.createIncognitoBrowserContext();
    }
    if (typeof browser.createBrowserContext === 'function') {
      return await browser.createBrowserContext();
    }
    return typeof browser.defaultBrowserContext === 'function'
      ? browser.defaultBrowserContext()
      : (browser.defaultBrowserContext || null);
  }
}
const browserMgr = new BrowserManager();

// Close browser when no sessions remain (optional but recommended)
async function maybeCloseBrowserIfIdle() {
  if (SESSIONS.size === 0 && browserMgr.browser) {
    try { await browserMgr.browser.close(); } catch {}
    browserMgr.browser = null;
    browserMgr.chromePath = null;
    console.log('[BROWSER] Closed (no active sessions)');
  }
}

// prune by TTL OR idle; run frequently so idle is accurate
async function pruneSessions() {
  const t = nowMs();
  for (const [sid, s] of SESSIONS.entries()) {
    const ageMs  = t - (s.createdAt || 0);
    const idleMs = t - (s.lastActivityAt || s.createdAt || 0);
    const idleLimit = s.idleMs ?? DEFAULT_IDLE_MS; // ✅ per-session idle

    if (ageMs > SESSION_TTL_MS || idleMs > idleLimit) {
      try { await s.cleanup?.(); } catch {}
      SESSIONS.delete(sid);
      console.log(`[SESSION] Closed sid=${sid} age=${ageMs}ms idle=${idleMs}ms idleLimit=${idleLimit}ms`);
    }
  }
  await maybeCloseBrowserIfIdle();
}

setInterval(() => {
  pruneSessions().catch(() => {});
}, 10_000).unref(); // every 10s

async function createSession({ embedUrl, referer, origin, ua, idleMs, timeoutMs = 15000 }) {
  const ctx = await browserMgr.newContext();
  const page = await ctx.newPage();
  await page.setUserAgent(ua || DEFAULT_UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Only block base64 images and off-domain navigations
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      const urlStr = req.url();

      // Block inline base64 images (safe for HLS)
      if (urlStr.startsWith('data:image/')) {
        return req.abort();
      }

      let host = '';
      try { host = new URL(urlStr).host; } catch {}

      const type = req.resourceType();
      const isNav = req.isNavigationRequest() || type === 'document';

      // Only block top-level navigations to non-allowlisted hosts
      if (isNav && !hostMatchesAllowed(host)) {
        return req.abort();
      }

      return req.continue();
    } catch {
      try { req.continue(); } catch {}
    }
  });

  // Passive playlist capture (no fetch/CDP)
  const cache = new Map();   // url -> { text, status, headers, ts }
  const waiters = new Map(); // url -> Set(resolveFn)

  page.on('response', async (res) => {
    const url = res.url();
    console.log('[RES]', url); // (Optional) noisy; you can remove if you want

    const ct  = (res.headers()['content-type'] || '').toLowerCase();
    const isM3U8 = url.toLowerCase().includes('.m3u8') ||
                   ct.includes('application/vnd.apple.mpegurl') ||
                   ct.includes('application/x-mpegurl');
    if (!isM3U8) return;
    try {
      const text = await res.text();
      const entry = { text, status: res.status(), headers: res.headers(), ts: nowMs() };
      cache.set(url, entry);
      const set = waiters.get(url);
      if (set && set.size) {
        for (const resolve of set) resolve(entry);
        waiters.delete(url);
      }
    } catch {}
  });

  // Promise to get first playlist quickly
  let firstResolve;
  const firstPromise = new Promise((r) => (firstResolve = r));
  const onFirst = async (res) => {
    const url = res.url();
    const ct  = (res.headers()['content-type'] || '').toLowerCase();
    const isM3U8 = url.toLowerCase().includes('.m3u8') ||
                   ct.includes('application/vnd.apple.mpegurl') ||
                   ct.includes('application/x-mpegurl');
    if (!isM3U8) return;
    try {
      const text = await res.text();
      firstResolve({ url, text, status: res.status(), headers: res.headers() });
      page.off('response', onFirst);
    } catch {}
  };
  page.on('response', onFirst);

  const sid = newSid();
  const session = {
    sid,
    ctx,
    page,       // embed page (never navigate away)
    embedUrl,
    referer,
    origin,
    ua: ua || DEFAULT_UA,
    createdAt: nowMs(),
    lastActivityAt: nowMs(), // activity timestamp
    idleMs: idleMs || DEFAULT_IDLE_MS, // ✅ NEW: per-session idle timeout
    cache,
    waiters,
    async waitForUrl(url, timeoutMsWait = 10000) {
      const existing = cache.get(url);
      if (existing) return existing;
      return new Promise((resolve) => {
        const set = waiters.get(url) || new Set();
        set.add(resolve);
        waiters.set(url, set);
        setTimeout(() => {
          const cur = waiters.get(url);
          if (cur && cur.has(resolve)) {
            cur.delete(resolve);
            if (!cur.size) waiters.delete(url);
            resolve(null);
          }
        }, timeoutMsWait);
      });
    },
    async cleanup() {
      try { await page.close(); } catch {}
      if (ctx && ctx.close) {
        try { await ctx.close(); } catch {}
      }
    },
  };
  SESSIONS.set(sid, session);

  const deadline = nowMs() + timeoutMs;
  const timeLeft = () => Math.max(0, deadline - nowMs());

  // Go to the EMBED page (with referer) and wait for first playlist capture
  await page.goto(embedUrl, {
    waitUntil: 'domcontentloaded',
    ...(referer ? { referer } : {}),
    timeout: timeLeft(),
  }).catch(() => {});

  // Wait a bounded time for first playlist
  const firstPlaylist = await Promise.race([
    firstPromise,
    new Promise((r) => setTimeout(() => r(null), timeLeft())),
  ]);

  return { sid, session, firstPlaylist };
}

function getSessionOrThrow(sid) {
  const s = sid && SESSIONS.get(sid);
  if (!s) throw new Error('Invalid or expired session (sid). Start with ?embed=...');

  const t = nowMs();
  const ageMs  = t - (s.createdAt || 0);
  const idleMs = t - (s.lastActivityAt || s.createdAt || 0);
  const idleLimit = s.idleMs ?? DEFAULT_IDLE_MS; // ✅ per-session idle

  // enforce TTL + idle immediately (not only in background prune)
  if (ageMs > SESSION_TTL_MS || idleMs > idleLimit) {
    try { s.cleanup?.(); } catch {}
    SESSIONS.delete(sid);
    throw new Error('Session expired (ttl/idle). Start again with ?embed=...');
  }

  return s;
}

// ------------- Express App -------------
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Server', 'nginx/1.18.0');
  next();
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/playlist', async (req, res) => {
  try {
    const embedUrl    = req.query.embed?.toString();
    const playlistUrl = req.query.url?.toString();
    const sid         = req.query.sid?.toString();

    // allowlist
    const toCheck = embedUrl || playlistUrl;
    if (!toCheck) {
      res.status(400).send('Missing query param: embed or url');
      return;
    }
    const host = new URL(toCheck).host;
    if (ALLOWLIST.length && !ALLOWLIST.includes(host)) {
      res.status(403).send('Origin not allowed by proxy');
      return;
    }

    const ua      = req.query.ua?.toString()      || DEFAULT_UA;
    const referer = req.query.referer?.toString() || process.env.UPSTREAM_REFERER || '';
    const origin  = req.query.origin?.toString()  || process.env.UPSTREAM_ORIGIN  || '';

    // ---- Warm-up from embed: respond with 302 to sid URL ----
    if (embedUrl && !sid) {
      const idleMs = parseIdleMs(req); // ✅ NEW: per-session idle config

      const { sid: newSid, firstPlaylist } = await createSession({
        embedUrl, referer, origin, ua,
        idleMs, // ✅ NEW
        timeoutMs: 15000,
      });

      if (!firstPlaylist?.url) {
        res.status(502).set('Content-Type', 'text/plain; charset=utf-8')
          .send(`Failed to capture first playlist for embed.\n${firstPlaylist?.error || 'empty'}`);
        return;
      }

      const redirectUrl = buildSidPlaylistUrl(req, firstPlaylist.url, newSid);
      res.status(302)
        .set('Cache-Control', 'no-store, must-revalidate')
        .set('Location', redirectUrl)
        .set('X-Session-Id', newSid)
        .send(`Redirecting to ${redirectUrl}`);
      return;
    }

    // ---- Reloads on the same session: serve fresh upstream playlist ----
    if (!sid || !playlistUrl) {
      res.status(400).send('Missing query param: sid and url');
      return;
    }

    const session = getSessionOrThrow(sid);

    // activity mark (this is what the idle timeout is based on)
    session.lastActivityAt = nowMs();

    // Make the headless browser fetch the playlist directly
    let upstream;
    try {
      upstream = await session.page.evaluate(async (u) => {
        const r = await fetch(u, { cache: 'no-store', mode: 'cors' });
        const text = await r.text();
        return {
          ok: r.ok,
          status: r.status,
          headers: Object.fromEntries([...r.headers]),
          text
        };
      }, playlistUrl);
    } catch (err) {
      res.status(502).send('Upstream fetch failed: ' + (err?.message || String(err)));
      return;
    }

    if (!upstream || !upstream.text) {
      res.status(502).send('Empty upstream playlist');
      return;
    }

    // Process the playlist exactly like before
    const baseUrl = playlistUrl;
    const lines = upstream.text.split(/\r?\n/);

    let processed = lines;
    if (isMasterPlaylist(lines)) {
      processed = rewriteMasterPlaylist(lines, baseUrl, req, sid);
      // res.set('X-Notice', 'Master playlist rewritten');
    }

    const out = processed.map((line) => {
      if (!line || line.startsWith('#')) {
        if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
          return absolutizeKeyOrMapUri(line, baseUrl);
        }
        return line;
      }
      return isAbsoluteUrl(line) ? line : toAbsolute(baseUrl, line);
    });

    res.status(200)
      .set('Cache-Control', 'no-store, must-revalidate')
      .set('Content-Type', 'application/vnd.apple.mpegurl')
      .send(out.join('\n'));

  } catch (err) {
    console.error(err);
    res.status(500).send('Proxy error: ' + (err?.message || String(err)));
  }
});

// Optional: explicit session close
app.get('/session/close', async (req, res) => {
  try {
    const sid = req.query.sid?.toString();
    if (!sid || !SESSIONS.has(sid)) {
      await maybeCloseBrowserIfIdle();
      return res.status(200).send('ok');
    }
    const s = SESSIONS.get(sid);
    try { await s.cleanup?.(); } catch {}
    SESSIONS.delete(sid);

    await maybeCloseBrowserIfIdle();
    res.status(200).send('ok');
  } catch {
    res.status(200).send('ok');
  }
});

// Start server
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Headless HLS playlist resolver and proxy on ${PORT}`);
});