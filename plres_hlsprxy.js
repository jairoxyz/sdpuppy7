// server.mjs
import express from 'express';
import http from 'http';
import dns from 'node:dns';
import { URL } from 'node:url';
import crypto from 'node:crypto';

// ✅ CloakBrowser import (drop-in Puppeteer replacement)
//import { launch } from 'cloakbrowser/puppeteer';
import { ensureBinary, clearCache, binaryInfo } from 'cloakbrowser';
import { ensureAndPruneCloakbrowserCache } from './cloakbrowserCache.js';


import Xvfb from 'xvfb';
import { error } from 'node:console';
import { userInfo } from 'node:os';

// --- Hardening: keep process alive on unexpected async errors ---
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

// --- Networking defaults ---
dns.setDefaultResultOrder('ipv4first');

// --- Logging ---
const LOG_ENABLED = 
  (process.env.LOG ?? process.env.DEBUG ?? '').toString().trim().toLowerCase();

const DEFAULT_LOG_ON =
  LOG_ENABLED === '1' || LOG_ENABLED === 'true' || LOG_ENABLED === 'yes' || LOG_ENABLED === 'on';

function log(...args) {
  if (DEFAULT_LOG_ON) console.log(...args);
}
function infoLog(...args) {
  console.log(...args);
}
function warn(...args) {
  if (DEFAULT_LOG_ON) console.warn(...args);
}
function errorLog(...args) {
  console.error(...args);
}

// --- Config ---
const PORT = process.env.PROXY_PORT || 3999;

const DEFAULT_UA =
  process.env.UPSTREAM_UA ||
  (process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.47 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.47 Safari/537.36');

const ALLOWLIST = (process.env.ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

let ALLOWED_HOSTS = new Set([
  'streamed.pk',
  'embedsports.top',
  'embedsporty.top',
  'embedstreams.top',
  'embed.st',
  'embedhd.st',
  'strmd.top',
  'poocloud.in',
  'pooembed.eu',
  'embedindia.st',
  'modifiles.fans',
  'vidfast.pro',
  'ppv.to',
  'ppv.st',
  'embed.ppv.to',
  '111movies.net',
  'hexa.su',
  'flixer.su',
  'dlstreams.top',
  'vidcore.net',
  'vidcore.io',
  'flixer.gd',
  'gn1r5n.org'
]);

function hostMatchesAllowed(host) {
  if (!ALLOWED_HOSTS || ALLOWED_HOSTS.size === 0) return true;
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

function isTruthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function cookiesToHeader(cookies = []) {
  return cookies
    .filter(c => c?.name && c?.value)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function parseRecordsCount(req, def = 1) {
  const raw = req.query.records;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  const i = Math.trunc(n);
  return Math.max(1, Math.min(20, i));
}

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

function buildSidPlaylistUrl(req, absoluteTargetUrl, sid) {
  const params = new URLSearchParams();
  params.set('url', absoluteTargetUrl);
  params.set('sid', sid);

  const q = req.query || {};
  const forwardList = [
    'ua', 'referer', 'origin', 'accept', 'accept_language', 'accept_encoding', 'authorization',
    'idle', 'idle_ms',
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

function buildSidKeyUrl(req, absoluteKeyUrl, sid) {
  const params = new URLSearchParams();
  params.set('url', absoluteKeyUrl);
  params.set('sid', sid);

  const q = req.query || {};
  if (q.idle_ms != null && q.idle_ms !== '') params.set('idle_ms', String(q.idle_ms));
  else if (q.idle != null && q.idle !== '') params.set('idle', String(q.idle));

  return `${req.protocol}://${req.get('host')}/key?${params.toString()}`;
}

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

// AES key uri rewriting
function rewriteExtXKeyUriToProxy(line, baseUrl, req, sid) {
  if (!line.startsWith('#EXT-X-KEY')) return line;

  const m = line.match(/URI=("([^"]+)"|([^,]+))/i);
  if (!m) return line;
  const raw = (m[2] || m[3] || '').trim();
  if (!raw) return line;

  const abs = isAbsoluteUrl(raw) ? raw : toAbsolute(baseUrl, raw);
  if (!/^https?:\/\//i.test(abs)) return line;

  const proxied = buildSidKeyUrl(req, abs, sid);
  return line.replace(/URI=("([^"]+)"|([^,]+))/i, `URI="${proxied}"`);
}

// ------------- Session Store -------------
const SESSIONS = new Map();  // sid -> session

// Session and browser cleanup
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours total time to live

// Default idle timeout is 2 minutes (your requirement)
const DEFAULT_IDLE_MS = 2 * 60 * 1000;      // 2 min since last /playlist(sid=...) access

// Clamp to avoid abuse / accidental extremes
const MIN_IDLE_MS = 15 * 1000;              // 15 seconds
const MAX_IDLE_MS = 30 * 60 * 1000;         // 30 minutes

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

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

// ------------- Browser Manager (CloakBrowser) -------------
// ------------- Browser Manager (SINGLE BROWSER ONLY) -------------
class BrowserManager {
  constructor() {
    this.browser = null;
    this.xvfbsession = null;
    this._launchPromise = null;
  }

  // SAFE FALLBACK: Only starts Xvfb if not already running
  ensureXvfb() {
  if (process.platform !== 'linux') return;
  if (this.xvfbsession) return;

  // If globalXvfb exists or DISPLAY is set, assume Xvfb is already running
  if (globalXvfb || process.env.DISPLAY) {
    log('[XVFB] Using existing display.');
    return;
  }

  try {
    this.xvfbsession = new Xvfb({
      silent: true,
      xvfb_args: ['-screen', '0', '1920x1080x24', '-ac', '-nolisten', 'tcp'],
    });
    this.xvfbsession.startSync();
    infoLog('[BROWSER] Xvfb started on display:', process.env.DISPLAY || ':99');
  } catch (err) {
    if (err.message.includes('already in use') || err.message.includes('locked')) {
      infoLog('[XVFB] Display already running, skipping fallback.');
    } else {
      errorLog('[BROWSER] ⚠️ Xvfb failed to start:', err.message);
      // Don't throw — let CloakBrowser attempt headless as last resort
    }
    this.xvfbsession = null;
  }
}

  stopXvfb() {
    if (!this.xvfbsession) return;
    try { this.xvfbsession.stopSync(); console.log('[XVFB] Stopped.'); } 
    catch (err) { console.warn('[XVFB] Stop failed:', err.message); }
    finally { this.xvfbsession = null; }
  }

  async ensureBrowser() {
    // Reuse existing healthy browser
    if (this.browser?.connected && this.browser?.process?.()?.exitCode === null) {
      return this.browser;
    }

    // Coalesce parallel launches
    if (this._launchPromise) return this._launchPromise;

    this._launchPromise = (async () => {
      try {
        // Clean up any zombie browser first
        if (this.browser) {
          try { await this.browser.close(); } catch {}
          this.browser = null;
        }

        const headless = process.platform === 'linux' ? false : true;
        if (!headless) this.ensureXvfb();

        // Launch with working-script settings
        this.browser = await (await import('cloakbrowser/puppeteer')).launch({
          headless,
          humanize: true,
          geoip: false,
          humanPreset: 'careful',  // Critical for stability
          protocolTimeout: 45_000,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '-window-size=1280,720',
            '--fingerprint=12345',  // Fixed fingerprint prevents conflicts
            '--autoplay-policy=no-user-gesture-required', // Allow autoplay without click
          ],
          defaultViewport: { width: 1280, height: 720 },
        });

        // Stop Xvfb AND null the browser ref so the next request relaunches.
        this.browser.on('disconnected', () => {
          console.warn('[BROWSER] Disconnected — will relaunch on next request');
          this.browser = null;
          try { this.stopXvfb(); } catch {}
        });

        return this.browser;
      } finally {
        this._launchPromise = null;
      }
    })();

    return this._launchPromise;
  }

  async newContext() {
    const tryIt = async () => {
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
    };

    try {
      return await tryIt();
    } catch (err) {
      const msg = String(err?.message || err || '');
      const recoverable =
        err?.name === 'ProtocolError' ||
        /timed out|Target closed|Connection closed|Protocol error/i.test(msg);
      if (!recoverable) throw err;

      console.warn('[BROWSER] newContext failed, force-closing + retrying once:', msg);
      await this.forceClose();
      return await tryIt();
    }
  }

  async forceClose() {
    if (!this.browser) { this.stopXvfb(); return; }
    try {
      await Promise.race([
        this.browser.close(),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    } catch {}
    this.browser = null;
    this.stopXvfb();
  }

  async closeBrowser() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
    }
    this.stopXvfb();
  }
}

const browserMgr = new BrowserManager();

async function maybeCloseBrowserIfIdle() {
  if (SESSIONS.size === 0 && browserMgr.browser) {
    await browserMgr.forceClose();
    log('[BROWSER] Closed (no active sessions)');
  }
}

async function pruneSessions() {
  const t = nowMs();
  
  for (const [sid, s] of SESSIONS.entries()) {
    const ageMs = t - (s.createdAt || 0);
    const idleMs = t - (s.lastActivityAt || s.createdAt || 0);
    const idleLimit = s.idleMs ?? DEFAULT_IDLE_MS;

    if (ageMs > SESSION_TTL_MS || idleMs > idleLimit) {
      try { await s.cleanup?.(); } catch {}
      SESSIONS.delete(sid);
      log(`[SESSION] Closed sid=${sid} age=${ageMs}ms idle=${idleMs}ms idleLimit=${idleLimit}ms`);
    }
  }
  await maybeCloseBrowserIfIdle();
}

setInterval(() => {
  pruneSessions().catch(() => {});
}, 15_000).unref();

async function createSession({
  embedUrl,
  referer,
  origin,
  ua,
  idleMs,
  m3u8Match,
  collectCount = 1,
  resolveOnly = false,
  useClicker = false,
  timeoutMs = process.platform === 'linux' ? 60_000 : 45_000
}) {
  const ctx = await browserMgr.newContext();
  const page = await ctx.newPage();

  // Kill popups when ad clicker is active
  if (useClicker) {
    page.on('popup', async (popup) => {
      log('[POPUP] Closing ad popup');
      try { await popup.close(); } catch {}
    });
  }

  page.on('error', (e) => console.error('[PAGE_ERROR]', e));
  page.on('pageerror', (e) => console.error('[PAGE_PAGEERROR]', e));

  await page.setUserAgent(ua || DEFAULT_UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });


  const matchSub = (m3u8Match != null && String(m3u8Match).trim() !== '')
    ? String(m3u8Match)
    : '';

  const embedHost = new URL(embedUrl).host;

  // When true, new requests are aborted.
  // Used for resolve_only mode to stop HLS segment downloads.
  let stopRequests = false;

  await page.setRequestInterception(true);

  const requestHandler = async (req) => {
    try {
      // Stop further segment/media requests after capture is complete.
      if (stopRequests) {
        return req.abort();
      }

      const urlStr = req.url();

         // 1. Hard abort for junk, trackers, and broken domains
      if (
        urlStr.startsWith('data:') ||
        urlStr.startsWith('chrome:') ||
        urlStr.startsWith('chrome-extension:') ||
        urlStr.includes('amazonaws.com/cam.edu') ||
        urlStr.includes('/ads') ||
        urlStr.includes('google-') ||
        urlStr.includes('wsrv.nl') ||
        urlStr.includes('pixelsee.app') ||
        urlStr.includes('openshield') ||
        urlStr.includes('canatrace') ||
        urlStr.includes('deuxseethe') ||
        urlStr.includes('appsflyersdk.com') ||
        urlStr.includes('ndcertainlywhen.com') ||
        urlStr.includes('pwrgamerz.com') ||
        urlStr.includes('usrpubtrk.com') ||
        urlStr.includes('unwrapsstow')
      ) {
        return req.abort();
      }
      
      let host = '';
      try {
        host = new URL(urlStr).host;
      } catch {}

      const type = req.resourceType();
      const isDoc = type === 'document' || req.isNavigationRequest();
      const frame = req.frame();
      const isMainFrame = frame === page.mainFrame();
      const isNav = isDoc && isMainFrame;

      if (
        isNav &&
        !hostMatchesAllowed(host) &&
        host !== embedHost &&
        !host.endsWith('.' + embedHost)
      ) {
        return req.abort();
      }

      return req.continue();
    } catch {
      try {
        req.continue();
      } catch {}
    }
  };

  const cache = new Map();
  const waiters = new Map();
  const requestMeta = new Map();

  const collectedUrls = [];
  const seenUrls = new Set();

  let collectedResolve;
  const collectedPromise = new Promise((r) => (collectedResolve = r));

  function collectUrl(url) {
    if (!url) return;
    if (seenUrls.has(url)) return;

    seenUrls.add(url);
    collectedUrls.push(url);

    // In resolve_only mode, stop new requests once enough playlists are seen.
    if (resolveOnly && collectedUrls.length >= collectCount) {
      stopRequests = true;
    }

    if (collectedResolve && collectedUrls.length >= collectCount) {
      collectedResolve(collectedUrls.slice(0, collectCount));
      collectedResolve = null;
    }
  }

  let firstResolve;
  const firstPromise = new Promise((r) => (firstResolve = r));

  const responseHandler = async (res) => {
    try {
      const url = res.url();

      if (
        url.startsWith('data:') ||
        url.startsWith('chrome:') ||
        url.includes('ads') ||
        url.startsWith('chrome-extension:')
      ) return;

      const rq = res.request();
      log(`[${rq.method()}]`, url, res.status());

      if (url.toLowerCase().includes('/verify') && !resolveOnly) {
        log('[RESP TEXT]', await res.text());
      }

      const ct = (res.headers()['content-type'] || '').toLowerCase();

      const isM3U8 = matchSub
        ? url.includes(matchSub)
        : (
          url.toLowerCase().includes('.m3u8') ||
          ct.includes('application/vnd.apple.mpegurl') ||
          ct.includes('application/x-mpegurl')
        );

      if (!isM3U8) return;

      collectUrl(url);

      const req = res.request?.();
      const reqMethod = req?.method?.() || 'UNKNOWN';
      const reqHeaders = req?.headers?.() || {};
      const frameUrl = req?.frame?.()?.url?.() || '';
      const refererHdr = reqHeaders['referer'] || '';
      const originHdr = reqHeaders['origin'] || '';

      let postData = null;
      try {
        postData = req?.postData?.() ?? null;
      } catch {}

      requestMeta.set(url, {
        reqMethod,
        reqHeaders,
        postData,
        referer: refererHdr,
        origin: originHdr,
        frameUrl,
        ts: nowMs(),
      });

      // IMPORTANT:
      // status and headers are already available here.
      // For resolve_only, we do NOT need the .m3u8 body.
      let text = '';

      if (!resolveOnly) {
        try {
          text = await res.text();
        } catch {}
      }

      const entry = {
        text,
        status: res.status(),
        headers: res.headers(),
        ts: nowMs()
      };

      cache.set(url, entry);

      if (firstResolve) {
        firstResolve({ url, ...entry });
        firstResolve = null;
      }

      const set = waiters.get(url);
      if (set && set.size) {
        for (const resolve of set) resolve(entry);
        waiters.delete(url);
      }
    } catch (e) {
      // swallow
    }
  };

  page.on('response', responseHandler);
  page.on('request', requestHandler);

  const sid = newSid();

  const session = {
    sid,
    ctx,
    page,
    embedUrl,
    referer,
    origin,
    ua: ua || DEFAULT_UA,
    createdAt: nowMs(),
    lastActivityAt: nowMs(),
    idleMs: idleMs || DEFAULT_IDLE_MS,
    cache,
    waiters,
    requestMeta,

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
      try {
        page.off('response', responseHandler);
        page.off('request', requestHandler);

        await page.setRequestInterception(false).catch(() => {});
        await page.close();
      } catch (e) {
        if (DEFAULT_LOG_ON) errorLog('[SESSION] Page close error:', e?.message);
      }

      if (ctx?.close) {
        try {
          await ctx.close();
        } catch {}
      }
    },
  };

  SESSIONS.set(sid, session);

  const deadline = nowMs() + timeoutMs;
  const timeLeft = () => Math.max(0, deadline - nowMs());

  infoLog('[APP] Received request for', embedUrl);

  // Do NOT await networkidle2.
  // HLS players keep downloading segments, so networkidle2 may never happen.
    page.goto(embedUrl, {
    waitUntil: 'domcontentloaded',
    ...(referer ? { referer } : {}),
    timeout: timeLeft(),
  }).catch(() => {});

  let clicking = false;

  // Only run the clicker if explicitly requested via &clicker=true
  if (useClicker) {
    clicking = true;
    
    // SMART CLICKER LOOP: Automates the "Verify -> Ad -> Real Player" flow
    const clickerLoop = (async () => {
      let centerClicks = 0;
      // Keep clicking until we get the m3u8 or time runs out
      while (clicking && timeLeft() > 2000) {
        try {
          // 1. Look for specific text buttons on the main page
          const box = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('button, a, div[role="button"], span, div'));
            for (const el of els) {
              const text = (el.innerText || '').toLowerCase();
              // Match the ad-gate and real player buttons
              if (
                text.includes('verify') || text.includes('play') || 
                text.includes('continue') || text.includes('click') || 
                text.includes('human') || text.includes('start')
              ) {
                const rect = el.getBoundingClientRect();
                // Ensure it's visible and reasonably sized
                if (rect.width > 30 && rect.height > 20 && rect.top >= 0 && rect.left >= 0) {
                  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
              }
            }
            return null;
          });

          if (box) {
            // Move mouse like a human, then click
            await page.mouse.move(box.x, box.y, { steps: 5 });
            await new Promise(r => setTimeout(r, 150));
            await page.mouse.click(box.x, box.y);
            log('[CLICK] Clicked text button at', box);
            centerClicks = 0; // Reset fallback counter
          } else if (centerClicks < 3) {
            // 2. Fallback: Click the center of the screen (hits iframe overlays)
            // We limit this to 3 times so we don't spam-click the real player once it loads
            await page.mouse.click(640, 360);
            log('[CLICK] Clicked center fallback');
            centerClicks++;
          }
        } catch (e) {
          // Page might be navigating or closed, ignore
        }
        
        // Wait 2 seconds before next click attempt
        await new Promise(r => setTimeout(r, 2000)); 
      }
    })();
  }

  const firstPlaylist = await Promise.race([
    firstPromise,
    new Promise((r) => setTimeout(() => r(null), timeLeft())),
  ]);

  // Stop the clicker loop once we have the playlist (or timeout)
  if (useClicker) clicking = false;

  if (collectCount > 1 && firstPlaylist) {
    await Promise.race([
      collectedPromise,
      new Promise((r) => setTimeout(() => r(null), timeLeft())),
    ]);
  }

  if (resolveOnly) {
    stopRequests = true;

    // Optional: ask the page itself to stop loading.
    // Not awaited because we do not want to block.
    page.evaluate(() => window.stop()).catch(() => {});
  }

  return {
    sid,
    session,
    firstPlaylist,
    collectedUrls: collectedUrls.slice(0, collectCount)
  };
}

// function getSessionOrThrow(sid) {
//   const s = sid && SESSIONS.get(sid);
//   if (!s) throw new Error(`Invalid or expired session: ${s}. Start with ?embed=...`);

//   const t = nowMs();
//   const ageMs = t - (s.createdAt || 0);
//   const idleMs = t - (s.lastActivityAt || s.createdAt || 0);
//   const idleLimit = s.idleMs ?? DEFAULT_IDLE_MS;

//   if (ageMs > SESSION_TTL_MS || idleMs > idleLimit) {
//     try { s.cleanup?.(); } catch {}
//     SESSIONS.delete(sid);
//     throw new Error('Session expired (ttl/idle). Start again with ?embed=...');
//   }

//   return s;
// }

function validateSession(sid) {
  const s = SESSIONS.get(sid);
  if (!s) {
    // Fake or unknown SID → reject immediately (no cleanup needed)
    return { session: null, status: 400, message: 'Invalid or fake session (sid). Start with ?embed=...' };
  }

  const t = nowMs();
  const ageMs = t - (s.createdAt || 0);
  const idleMs = t - (s.lastActivityAt || s.createdAt || 0);
  const idleLimit = s.idleMs ?? DEFAULT_IDLE_MS;

  if (ageMs > SESSION_TTL_MS || idleMs > idleLimit) {
    // Stale/expired SID → clean up immediately
    try { s.cleanup?.(); } catch {}
    SESSIONS.delete(sid);
    // Browser idle check runs every 15s anyway, so no need to await here
    return { session: null, status: 410, message: 'Session expired (ttl/idle). Start again with ?embed=...' };
  }

  return { session: s };
}


// ------------- Express App -------------
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Server', 'nginx/1.18.0');
  next();
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/health/memory', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    sessions: SESSIONS.size,
    browserConnected: !!browserMgr.browser?.connected,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
    },
    uptime: process.uptime(),
  });
});

app.get('/playlist', async (req, res) => {
  try {
    const embedUrl = req.query.embed?.toString();
    const playlistUrl = req.query.url?.toString();
    const sid = req.query.sid?.toString();

    const isEmbedRequest = !!embedUrl && !sid;
    const isRefreshRequest = !!sid && !!playlistUrl;
    
    if (!isEmbedRequest && !isRefreshRequest) {
      res.status(400).send('Missing query param: embed or url');
      return;
    }

    const host = new URL(embedUrl || playlistUrl).host;
    
    if (ALLOWLIST.length && !ALLOWLIST.includes(host)) {
      res.status(403).send('Origin not allowed by proxy');
      return;
    }

    const ua = req.query.ua?.toString() || DEFAULT_UA;
    const referer = req.query.referer?.toString() || process.env.UPSTREAM_REFERER || '';
    const origin = req.query.origin?.toString() || process.env.UPSTREAM_ORIGIN || '';

    if (isEmbedRequest) {
      const resolveOnly = isTruthy(req.query.resolve_only);
      const useClicker = isTruthy(req.query.clicker);
      const idleMs = parseIdleMs(req);
      const m3u8Match = req.query.m3u8_match?.toString() || '';
      const recordsCount = resolveOnly ? parseRecordsCount(req, 1) : 1;

      const { sid: newSid, session, firstPlaylist, collectedUrls } = await createSession({
        embedUrl,
        referer,
        origin,
        ua,
        idleMs,
        m3u8Match,
        collectCount: recordsCount,
        resolveOnly,
        useClicker,
        timeoutMs: 45_000,
      });

      if (resolveOnly) {
        const urls = (collectedUrls && collectedUrls.length)
          ? collectedUrls
          : (firstPlaylist?.url ? [firstPlaylist.url] : []);

        if (!urls.length) {
          try { await session.cleanup?.(); } catch {}
          try { SESSIONS.delete(newSid); } catch {}
          await maybeCloseBrowserIfIdle();

          res.status(502)
            .set('Cache-Control', 'no-store, must-revalidate')
            .set('Content-Type', 'text/plain; charset=utf-8')
            .send('Failed to capture any matching playlist');
          
          // Do not block the HTTP response on browser shutdown.
          maybeCloseBrowserIfIdle().catch(() => {});

          return;
        }

        const records = await Promise.all(urls.slice(0, recordsCount).map(async (u) => {
          let playlistCookies = [];
          try { playlistCookies = await session.page.cookies(u); } catch {}
          const cookieHeader = cookiesToHeader(playlistCookies);
          const meta = session.requestMeta?.get(u);
          const cachedEntry = session.cache?.get(u); //Fetch cached response to get status
          
          const realReferer = meta?.referer || session.referer || '';
          const realOrigin  = meta?.origin  || session.origin  || '';
          const base = meta?.reqHeaders ? { ...meta.reqHeaders } : {};
          const headers = {
            ...base,
          };
          delete headers['host'];
          delete headers['Host'];
          delete headers['content-length'];
          delete headers['Content-Length'];
          
          return {
            url: u,
            status: cachedEntry?.status ?? null, //Include HTTP response status code
            //responseHeaders: cachedEntry?.headers ?? null, // Actual .m3u8 HTTP response headers
            // Request side fields
            method: meta?.reqMethod || null,
            headers,
            body: meta?.postData ?? null,
            initiator: meta?.frameUrl || null,
          };
        }));

        // Stop the page quickly, but do not let cleanup hang the response forever.
        try {
          await Promise.race([
            session.cleanup?.(),
            new Promise(r => setTimeout(r, 2000))
          ]);
        } catch {}

        SESSIONS.delete(newSid);

        res.status(200)
          .set('Cache-Control', 'no-store, must-revalidate')
          .json({ ok: true, records });

        // Close browser in the background if idle.
        maybeCloseBrowserIfIdle().catch(() => {});

        return;
      }

      if (!firstPlaylist?.url) {
        try {
          await Promise.race([
            session.cleanup?.(),
            new Promise(r => setTimeout(r, 2000))
          ]);
        } catch {}

        SESSIONS.delete(newSid);

        res.status(502)
          .set('Cache-Control', 'no-store, must-revalidate')
          .set('Content-Type', 'text/plain; charset=utf-8')
          .send(`Failed to capture first playlist for embed.\n${firstPlaylist?.error || 'empty'}`);

        maybeCloseBrowserIfIdle().catch(() => {});

        return;
      }

      // Abort and forward error status if the initial embed playlist failed
      if (firstPlaylist.status >= 400) {
        try {
          await Promise.race([
            session.cleanup?.(),
            new Promise(r => setTimeout(r, 2000))
          ]);
        } catch {}

        SESSIONS.delete(newSid);

        res.status(firstPlaylist.status)
          .set('Cache-Control', 'no-store, must-revalidate')
          .set('Content-Type', 'text/plain; charset=utf-8')
          .send(`Upstream embed playlist returned error status: ${firstPlaylist.status}`);

        maybeCloseBrowserIfIdle().catch(() => {});

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

    if (!sid || !playlistUrl) {
      res.status(400).send('Missing query param: sid and url');
      return;
    }

    //const session = getSessionOrThrow(sid);
    const { session, status, message } = validateSession(sid);
    if (!session) return res.status(status).send(message);
    session.lastActivityAt = nowMs();

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

    if (!upstream) {
      res.status(502).send('Empty upstream playlist response');
      return;
    }

    // Forward upstream 4xx/5xx status to the client.
    if (upstream.status >= 400) {
      res.status(upstream.status)
        .set('Cache-Control', 'no-store, must-revalidate')
        .send(`Upstream playlist returned error status: ${upstream.status}`);
      return;
    }

    if (!upstream.text) {
      res.status(502).send('Empty upstream playlist text');
      return;
    }

    const baseUrl = playlistUrl;
    const lines = upstream.text.split(/\r?\n/);

    let processed = lines;
    if (isMasterPlaylist(lines)) {
      processed = rewriteMasterPlaylist(lines, baseUrl, req, sid);
    }

    const out = processed.map((line) => {
      if (!line || line.startsWith('#')) {
        if (line.startsWith('#EXT-X-KEY')) {
          return rewriteExtXKeyUriToProxy(line, baseUrl, req, sid);
        }
        if (line.startsWith('#EXT-X-MAP')) {
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

// For AES key uri rewriting
app.get('/key', async (req, res) => {
  try {
    const sid = req.query.sid?.toString();
    const keyUrl = req.query.url?.toString();
    
    if (!sid || !keyUrl) {
      res.status(400).send('Missing query param: sid and url');
      return;
    }

    if (ALLOWLIST.length) {
      const host = new URL(keyUrl).host;
      if (!ALLOWLIST.includes(host)) {
        res.status(403).send('Origin not allowed by proxy');
        return;
      }
    }

    //const session = getSessionOrThrow(sid);
    const { session, status, message } = validateSession(sid);
    if (!session) return res.status(status).send(message);
    session.lastActivityAt = nowMs();

    let upstream;
    try {
      upstream = await session.page.evaluate(async (u) => {
        const r = await fetch(u, {
          cache: 'no-store',
          mode: 'cors',
        });

        const buf = await r.arrayBuffer();
        return {
          status: r.status,
          type: r.type,
          headers: Object.fromEntries([...r.headers]),
          bytes: Array.from(new Uint8Array(buf)),
        };
      }, keyUrl);
    } catch (err) {
      res.status(502).send('Upstream key fetch failed: ' + (err?.message || String(err)));
      return;
    }

    if (!upstream) {
      res.status(502).send('Empty upstream key response');
      return;
    }

    // Stop proxying and forward the exact error status to the client
    if (upstream.status >= 400) {
      res.status(upstream.status)
        .set('Cache-Control', 'no-store, must-revalidate')
        .send(`Upstream key returned error status: ${upstream.status}`);
      return;
    }

    const ct =
      upstream.headers?.['content-type'] ||
      upstream.headers?.['Content-Type'] ||
      'application/octet-stream';

    const body = Buffer.from(upstream.bytes || []);

    res.status(upstream.status || 200)
      .set('Cache-Control', 'no-store, must-revalidate')
      .set('Content-Type', ct)
      .send(body);

  } catch (err) {
    console.error(err);
    res.status(500).send('Key proxy error: ' + (err?.message || String(err)));
  }
});

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

// ------------- App Init & Lifecycle -------------

// ---------- One-time Cloakbrowser cache prep ----------
let preparedPromise = null;
function prepareOnce() {
  // Promise-based "once" is concurrency-safe: multiple callers share the same in-flight promise.
  if (!preparedPromise) {
    preparedPromise = (async () => {
      try {
        await ensureAndPruneCloakbrowserCache({ syncUpdateAtStartup: true });
        console.log('[INIT] Cloakbrowser cache prepared');
      } catch (e) {
        console.warn('[INIT] Cloakbrowser cache prune skipped:', e?.message || e);
      }
    })();
  }
  return preparedPromise;
}

let globalXvfb = null;

async function initApp() {
  infoLog('[INIT] Starting up ...')

  // Prepare Cloakbrowser
  await prepareOnce();

  // Start Xvfb Synchronously on Linux (Guaranteed before server listens)
  if (process.platform === 'linux') {
    //console.log('[INIT] Starting Xvfb...');
    try {
      globalXvfb = new Xvfb({
        silent: true,
        xvfb_args: ['-screen', '0', '1920x1080x24', '-ac', '-nolisten', 'tcp'],
      });
      globalXvfb.startSync();
      await new Promise(r => setTimeout(r, 500));
      infoLog('[INIT] Xvfb started on display:', process.env.DISPLAY || ':99');
    } catch (err) {     
      // Option A: Fallback to headless mode if Xvfb fails (keeps server running)
      if (err.message.includes('already in use') || err.message.includes('locked')) {
        infoLog('[INIT] Display already running, proceeding with existing Xvfb.');
        globalXvfb = null; // Don't try to stop something we didn't start
      } 
      // Option B: Fatal exit if headful is required (recommended for CloakBrowser stealth)
      else {
        console.error('[INIT] ⚠️ Xvfb failed to start:', err.message);
        process.exit(1);
      }
    }
  }

  // Start Express Server
  const server = http.createServer(app);
  server.on('error', (err) => console.error('[SERVER_ERROR]', err));
  server.on('clientError', (err, socket) => {
    console.error('[CLIENT_ERROR]', err?.message || err);
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  });

  server.listen(PORT, () => {
    infoLog(`[APP] HLS playlist resolver and proxy listening on ${PORT}`);
  });

  // Attach Graceful Shutdown
  attachShutdownHandlers(server);
}

function attachShutdownHandlers(server) {
  let shuttingDown = false;

  async function gracefulShutdown(signal = 'SIGINT') {
    if (shuttingDown) return;
    shuttingDown = true;
    infoLog(`[SHUTDOWN] Received ${signal}, cleaning up...`);

    try { await new Promise(r => server.close(r)); } catch {}
    try { await Promise.allSettled(Array.from(SESSIONS.values()).map(s => s.cleanup?.())); } catch {}
    try { await browserMgr.closeBrowser(); } catch {}
    try { if (globalXvfb) { globalXvfb.stopSync(); log('[SHUTDOWN] Xvfb stopped'); } } catch {}

    process.exit(0);
  }

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('exit', () => { try { globalXvfb?.stopSync(); } catch {} });
}

// Run initialization (replaces direct server.listen())
initApp().catch(err => {
  console.error('[INIT] Fatal startup error:', err);
  process.exit(1);
});