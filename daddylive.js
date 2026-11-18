// daddylive.js
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { get as impersGet, post as impersPost } from 'impers';

const PROOF_KEY_HEX = "b7fec5f0095bed75e5ef5f5222a732a41343b1ebb65f6490d926eaf7538b3137";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

// ============================================================================
// 1. Regex Extraction
// ============================================================================
function extractDataFromHtml(html) {
    const getVar = (name) => {
        const match = html.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`));
        return match ? match[1].trim().replace(/["']/g, '') : null;
    };

    const src = getVar('SRC');
    const channel = getVar('CHANNEL');
    const edge = getVar('EDGE');
    const tsite = getVar('TSITE');
    
    let chal = null;
    const chalMatch = html.match(/const\s+CHAL\s*=\s*(\{[^}]+\});/);
    if (chalMatch) {
        try { chal = JSON.parse(chalMatch[1].replace(/'/g, '"')); } catch (e) {}
    }

    return { src, channel, edge, chal, tsite };
}

// ============================================================================
// 2. Crypto & Decryption Helpers
// ============================================================================
function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64');
}

function b64urlEncode(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateSignature(channel, n, e) {
    const keyBytes = Buffer.from(PROOF_KEY_HEX, 'hex');
    const message = `${channel}|${n}|${e}`;
    const hmac = crypto.createHmac('sha256', keyBytes);
    hmac.update(message);
    return b64urlEncode(hmac.digest());
}

function decryptPlaylist(playlistText, keyB64url) {
    if (!keyB64url || playlistText.includes('://')) return playlistText;
    
    const keyBytes = b64urlDecode(keyB64url);
    const algo = keyBytes.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr';
    const lines = playlistText.split('\n');
    const decryptedLines = [];
    let mediaSequence = 0;

    for (const line of lines) {
        const stripped = line.trim();
        if (!stripped) { decryptedLines.push(line); continue; }
        if (stripped.startsWith('#')) {
            decryptedLines.push(line);
            const match = stripped.match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/);
            if (match) mediaSequence = parseInt(match[1], 10);
            continue;
        }
        try {
            const ctBytes = b64urlDecode(stripped);
            const iv = Buffer.alloc(16, 0);
            iv.writeBigUInt64BE(BigInt(mediaSequence), 8);
            const decipher = crypto.createDecipheriv(algo, keyBytes, iv);
            let ptBytes = decipher.update(ctBytes);
            ptBytes = Buffer.concat([ptBytes, decipher.final()]);
            decryptedLines.push(ptBytes.toString('utf-8'));
            mediaSequence++;
        } catch (err) {
            decryptedLines.push(line);
        }
    }
    return decryptedLines.join('\n');
}

function decodeBase64ChunkShuffle(_0x2d612d) {
    if (!_0x2d612d) {
      return false;
    }
    const _0x569c31 = [2, 0, 3, 1];
    const _0x3691bd = 4;
    _0x2d612d = atob(_0x2d612d);
    const _0x4f2723 = _0x2d612d.length;
    const _0x1a9bb4 = Math.ceil(_0x4f2723 / _0x3691bd);
    const _0x5aeaad = [];
    let _0x515c1e = 0;
    for (let _0x5c5043 = 0; _0x5c5043 < _0x3691bd; _0x5c5043++) {
      const _0x53e068 = _0x2d612d.substr(_0x515c1e, _0x1a9bb4);
      _0x5aeaad.push(_0x53e068);
      _0x515c1e += _0x1a9bb4;
    }
    const _0xa44d35 = [];
    for (let _0x4eb802 = 0; _0x4eb802 < _0x569c31.length; _0x4eb802++) {
      let _0x2eaa06 = String(_0x5aeaad[_0x4eb802]);
      _0x2eaa06 = _0x2eaa06.slice(0, 3) + _0x2eaa06.slice(4);
      _0xa44d35[_0x569c31[_0x4eb802]] = atob(_0x2eaa06);
    }
    const _0x235113 = _0xa44d35.join("");
    const _0x3a770b = atob(_0x235113);
    try {
      return JSON.parse(_0x3a770b);
    } catch (_0x5cc93e) {
      return false;
    }
}

// ============================================================================
// 3. Turnstile Solver 
// ============================================================================
async function solveTurnstileMin(browserMgr, url, siteKey, action='') {
    browserMgr.activeTasks = (browserMgr.activeTasks || 0) + 1;
    const ctx = await browserMgr.newContext();
    const page = await ctx.newPage();
    
    try {
        await page.setRequestInterception(true);
        
        page.on("request", async (request) => {
            if ([url, url + "/"].includes(request.url()) && request.resourceType() === "document") {
                let htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title></title>
</head>
<body>
    <div class="turnstile"></div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>
    <script>
        window.onloadTurnstileCallback = function () {
            turnstile.render('.turnstile', {
                sitekey: '<site-key>',
                action: '<action>',
                callback: function (token) {
                    var c = document.createElement('input');
                    c.type = 'hidden';
                    c.name = 'cf-response';
                    c.value = token;
                    document.body.appendChild(c);
                },
            });
        };
    </script>
</body>
</html>`;
                
                htmlContent = htmlContent.replace(/<site-key>/g, siteKey);
                htmlContent = htmlContent.replace(/<action>/g, action);
                
                await request.respond({
                    status: 200,
                    contentType: "text/html",
                    body: htmlContent,
                });
            } else {
                await request.continue();
            }
        });

        await page.goto(url, { waitUntil: "domcontentloaded" });
        
        console.log('[TURNSTILE] Waiting for turnstile token...');
        const timeoutMs = 30000;
        let token = null;

        await new Promise((r) => setTimeout(r, 1500)); 
        
        try {
            const tokenEl = await page.waitForFunction(
                () => {
                    const el = document.querySelector('[name="cf-response"]');
                    return el && el.value && el.value.length > 10 ? el : false;
                },
                { polling: 100, timeout: timeoutMs }
            );
            token = tokenEl ? await page.evaluate(el => el.value, tokenEl) : null;
        } catch (err) {
            console.log('[TURNSTILE] Auto-solve timed out.');
        }

        if (!token || token.length < 10) {
            throw new Error("Failed to get token");
        }
        
        console.log('[TURNSTILE] ✓ Token solved successfully.');
        return token;

    } catch (e) {
        console.error('[TURNSTILE] Fatal Error:', e.message);
        throw e;
    } finally {
        try { await ctx.close(); } catch {}
        browserMgr.activeTasks = Math.max(0, (browserMgr.activeTasks || 0) - 1);
    }
}

// ============================================================================
// ENDPOINT 1: /daddylive/token
// to get CFTS token, ticket and playlist url: 
// ?embed_url=https://dembed.st/premiumtv/daddy.php?id=303&ref=https://thedaddy.li/
// ============================================================================
export async function handleDaddyliveToken(req, res, browserMgr) {
    browserMgr.activeTasks = (browserMgr.activeTasks || 0) + 1;
    
    try {
        const { embed_url, playlist_url, ticket, ref } = req.query;

        // ==========================================================================
        // PATH A: FULL INIT
        // ==========================================================================
        if (embed_url && !playlist_url && !ticket) {
            console.log('[DADDYLIVE/TOKEN] Token request received for:', embed_url);
            const ua = req.query.ua || DEFAULT_UA;
            const edgeOrigin = new URL(embed_url).origin;

            // 1. Fetch HTML via impers with forced HTTP/1.1 (embed server rejects HTTP/2)
            //console.log('[DADDYLIVE/TOKEN] Fetching embed HTML via impers (HTTP/1.1)...');
            const htmlRes = await fetch(embed_url, {
                method: "GET",
                headers: {
                    "User-Agent": ua,
                    "Referer": ref,
                    "Origin": new URL(ref).origin,
                }
            });
            
            if (!htmlRes.ok) throw new Error(`Embed HTML fetch failed: ${htmlRes.status}`);
            const html = await htmlRes.text();
            if (!html || html.length < 500) throw new Error('Failed to fetch embed HTML');

            // 2. Extract via Regex
            const data = extractDataFromHtml(html);
            if (!data.chal || !data.src || !data.edge) throw new Error('Failed to extract SRC/EDGE/CHAL');

            // 3. Solve Turnstile (Browser)
            let turnstileToken = null;
            if (data.tsite) {
                console.log('[DADDYLIVE/TOKEN] Solving CF Turnstile ...');
                turnstileToken = await solveTurnstileMin(browserMgr, embed_url, data.tsite, 'watch');
            }

            // 4. Get Ticket via impers with forced HTTP/1.1
            const pValue = generateSignature(data.channel, data.chal.n, data.chal.e);
            const ticketPayload = new URLSearchParams({
                redeem: '1',
                n: data.chal.n,
                e: String(data.chal.e),
                m: data.chal.m,
                p: pValue
            });
            if (turnstileToken) ticketPayload.append('cf-turnstile-response', turnstileToken);

            console.log('[DADDYLIVE/TOKEN] Fetching edge ticket ...');
            const ticketRes = await fetch(embed_url, {
                method: 'POST',
                headers: {
                    'User-Agent': ua,
                    'Referer': embed_url,
                    'Origin': edgeOrigin,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: ticketPayload.toString()
            });

            if (!ticketRes.ok) throw new Error(`Ticket request failed: ${ticketRes.status}`);
            const ticketData = await ticketRes.json();
            const newTicket = typeof ticketData === 'string' ? ticketData : (ticketData?.ticket || '');
            if (!newTicket) throw new Error('Failed to get ticket');

            // 5. Get Token from Edge via impers (default HTTP/2)
            const tokenUrl = `${data.edge}/api/playlist-token?slug=${encodeURIComponent(data.channel)}&tk=${encodeURIComponent(newTicket)}`;
            console.log('[DADDYLIVE/TOKEN] Fetching playlist token ...');
            
            const tokenRes = await impersGet(tokenUrl, {
                headers: {
                    'User-Agent': ua,
                    'Referer': `${edgeOrigin}/`,
                    'Origin': edgeOrigin
                },
                impersonate: "chrome",
            });

            if (tokenRes.status !== 200) throw new Error(`Token request failed: ${tokenRes.status}`);
            const tokenData = tokenRes.json();
            if (!tokenData.token) throw new Error('Failed to get token from edge');

            // // 6. Get Sealed Playlist from Edge via impers (default HTTP/2)
            // const sealedUrl = `${data.src}?t=${encodeURIComponent(tokenData.token)}&_=${Date.now()}`;
            // console.log('[DADDYLIVE/TOKEN] Fetching sealed playlist via impers (HTTP/2)...');
            
            // const plRes = await impersGet(sealedUrl, {
            //     headers: {
            //         'User-Agent': ua,
            //         'Referer': `${edgeOrigin}/`,
            //         'Origin': edgeOrigin
            //     }
            // });

            // if (plRes.status !== 200) throw new Error(`Playlist request failed: ${plRes.status}`);
            // const sealedText = plRes.body;

            // 7. Decrypt locally
            //const cleanPlaylist = decryptPlaylist(sealedText, tokenData.k);

            res.json({
                ok: true,
                ticket: newTicket,
                edge_domain: data.edge,
                playlist_url: data.src,
                slug: data.channel,
                token: tokenData.token,
                k: tokenData.k,
                ttl: tokenData.ttl || 120,
                //playlist_text: cleanPlaylist
            });
        } 
        // ==========================================================================
        // PATH B: TOKEN REFRESH 
        // to refresh token based on ttl
        // ?embed_url=https://dembed.st/...&ticket=...&playlist_url=...
        // ==========================================================================
        else if (playlist_url && ticket && embed_url) {
            console.log('[DADDYLIVE/TOKEN] Received token refresh request for:', playlist_url);
            const pUrl = new URL(playlist_url);
            const edgeDomain = `${pUrl.protocol}//${pUrl.host}`;
            const pathParts = pUrl.pathname.split('/').filter(Boolean);
            const slug = pathParts[0] || 'default';
            const ua = req.query.ua || DEFAULT_UA;
            const edgeOrigin = new URL(embed_url).origin;

            const tokenUrl = `${edgeDomain}/api/playlist-token?slug=${encodeURIComponent(slug)}&tk=${encodeURIComponent(ticket)}`;
            //console.log('[DADDYLIVE/TOKEN] Fetching refresh token ...');
            
            const tokenRes = await impersGet(tokenUrl, {
                headers: {
                    'User-Agent': ua,
                    'Referer': `${edgeOrigin}/`,
                    'Origin': edgeOrigin
                },
                impersonate: "chrome",
            });

            if (tokenRes.status !== 200) throw new Error(`Token request failed: ${tokenRes.status}`);
            const tokenData = tokenRes.json();
            if (!tokenData.token) throw new Error('Failed to get token from edge');

            res.json({ ok: true, token: tokenData.token, k: tokenData.k, ttl: tokenData.ttl || 120 });
        } 
        // ==========================================================================
        // PATH C: INVALID REQUEST
        // ==========================================================================
        else {
            res.status(400).json({ ok: false, error: 'Missing embed_url (init) OR playlist_url+ticket+embed_url (refresh)' });
        }
    } catch (err) {
        console.error('[DADDYLIVE/TOKEN] Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        browserMgr.activeTasks = Math.max(0, (browserMgr.activeTasks || 0) - 1);
    }
}

// ============================================================================
// ENDPOINT 2: /daddylive/playlist
// To proxy playlist
// ?embed_url=https://dembed.st/...&token=...&playlist_url=...&k=...
// ============================================================================
export async function handleDaddylivePlaylist(req, res, browserMgr) {
    
    browserMgr.activeTasks = (browserMgr.activeTasks || 0) + 1;
    
    try {
        const { embed_url, playlist_url, token, k } = req.query;
        if (!embed_url || !playlist_url || !token || !k) {
            return res.status(400).json({ ok: false, error: 'Missing parameters' });
        }
        console.log('[DADDYLIVE/PLAYLIST] Received playlist request for:', playlist_url);
        const ua = req.query.ua || DEFAULT_UA;
        const edgeOrigin = new URL(embed_url).origin;
        const cleanUrl = playlist_url.split('?')[0];
        const sealedUrl = `${cleanUrl}?t=${encodeURIComponent(token)}&_=${Date.now()}`;
        
        const plRes = await impersGet(sealedUrl, {
            headers: {
                    'User-Agent': ua,
                    'Referer': `${edgeOrigin}/`,
                    'Origin': edgeOrigin
                },
                impersonate: "chrome",
        });

        if (plRes.status !== 200) throw new Error(`Playlist request failed: ${plRes.status}`);
        const sealedText = plRes.text;

        const cleanPlaylist = decryptPlaylist(sealedText, k);
        res.json({ ok: true, playlist_text: cleanPlaylist });
        
    } catch (err) {
        console.error('[DADDYLIVE/PLAYLIST] Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        browserMgr.activeTasks = Math.max(0, (browserMgr.activeTasks || 0) - 1);
    }
}

// ============================================================================
// ENDPOINT 3: /daddylive/waterera 
// To get and proxy playlist, send cfts after first call
// ?url=https://waterera.net/e/03pax86wzf579&token=...
// ============================================================================
export async function handleWaterera(req, res, browserMgr) {
    try {
        // 'url' is ALWAYS required to derive the correct Referer and Origin headers
        const { url, playlist_url, token: providedToken } = req.query;
        
        if (!url) {
            return res.status(400).json({ ok: false, error: 'Missing required parameter: url' });
        }

        const ua = req.query.ua || DEFAULT_UA;
        const embedOrg = new URL(url).origin; // Always derive Origin from the embed URL
        const ref = req.query.ref || "https://thedaddy.li/";

        // ==========================================================================
        // FAST PATH: Playlist Refresh (playlist_url provided, skip Turnstile/Exchange)
        // ==========================================================================
        if (playlist_url) {
            console.log('[WATERERA] Fetching playlist from:', playlist_url);
            
            const plRes = await fetch(playlist_url, {
                method: "GET",
                headers: {
                    "User-Agent": ua,
                    'Referer': `${embedOrg}/`, 
                    'Origin': embedOrg,
                }
            });
            
            if (!plRes.ok) throw new Error(`Playlist refresh failed: ${plRes.status}`);
            const playlistText = await plRes.text();

            return res.json({ 
                ok: true, 
                playlist_url: playlist_url,
                playlist_text: playlistText 
            });
        }

        // ==========================================================================
        // SLOW PATH: Full Initialization (No playlist_url, must solve and exchange)
        // ==========================================================================
        console.log('[WATERERA] Full init request received for:', url);
        
        const htmlRes = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent": ua,
                "Referer": ref,
            }
        });
        
        if (!htmlRes.ok) throw new Error(`HTML fetch failed: ${htmlRes.status}`);
        const html = await htmlRes.text();
        if (!html || html.length < 500) throw new Error('Failed to fetch embed HTML');
        
        const match = html.match(/(?:clappr|script).*?window\.\w+\s*=\s*'(.{50000,}?)'/s);
        if (!match) throw new Error('Failed to extract econf from HTML');
        
        const result = match[1];
        const econf = decodeBase64ChunkShuffle(result); 
        
        let streamUrl = econf.stream_url;
        let finalToken = providedToken;

        if (econf.turnstile_key) {
            if (!finalToken) {
                console.log(`[WATERERA] Solving Turnstile for: ${url}`);
                finalToken = await solveTurnstileMin(browserMgr, url, econf.turnstile_key);
            } else {
                console.log(`[WATERERA] Using provided Turnstile token, skipping solve.`);
            }

            const payload = new URLSearchParams({
                hash: econf.turnstile_hash,
                token: finalToken,
                ts: econf.ts
            });

            console.log('[WATERERA] Exchanging token for stream URL...');
            const turnstileRes = await fetch(url.replace('/e/', '/turnstile/'), {
                method: 'POST',
                headers: {
                    'User-Agent': ua,
                    'Referer': `${embedOrg}/`,
                    'Origin': embedOrg,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: payload.toString()
            });

            if (!turnstileRes.ok) {
                const errText = await turnstileRes.text();
                throw new Error(`Turnstile exchange failed: ${turnstileRes.status} - ${errText}`);
            }
            
            const streamData = await turnstileRes.json();
            streamUrl = streamData.stream_url;
        }

        if (!streamUrl) {
            throw new Error('Failed to obtain stream URL');
        }

        console.log('[WATERERA] Fetching initial playlist content from:', streamUrl);
        const plRes = await fetch(streamUrl, {
            method: "GET",
            headers: {
                "User-Agent": ua,
                'Referer': `${embedOrg}/`,
                'Origin': embedOrg,
            }
        });
        
        if (!plRes.ok) throw new Error(`Initial playlist fetch failed: ${plRes.status}`);
        const playlistText = await plRes.text();

        // Return playlist_url (streamUrl) so the client can cache it for the Fast Path
        res.json({ 
            ok: true, 
            token: finalToken,
            playlist_url: streamUrl, 
            playlist_text: playlistText 
        });
        
    } catch (err) {
        console.error('[WATERERA] Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
}