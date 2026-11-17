// daddylive.js
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { request as undiciRequest } from 'undici';

const PROOF_KEY_HEX = "b7fec5f0095bed75e5ef5f5222a732a41343b1ebb65f6490d926eaf7538b3137";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

// ============================================================================
// 1. Regex Extraction (Runs on raw HTML string from undici)
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

// ============================================================================
// 3. Turnstile Solver
// ============================================================================
async function solveTurnstileMin(browserMgr, url, siteKey) {
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
                action: 'watch',
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
// ============================================================================
export async function handleDaddyliveToken(req, res, browserMgr) {
    // CRITICAL: Keep browser alive for the ENTIRE duration of this request
    browserMgr.activeTasks = (browserMgr.activeTasks || 0) + 1;
    
    try {
        const { embed_url, playlist_url, ticket } = req.query;

        // ==========================================================================
        // PATH A: FULL INIT
        // ==========================================================================
        if (embed_url && !playlist_url && !ticket) {
            console.log('[DADDYLIVE/TOKEN] Init request received for:', embed_url);
            const ua = req.query.ua || DEFAULT_UA;

            // 1. Fetch HTML via undici
            const htmlRes = await undiciRequest(embed_url, {
                method: 'GET',
                headers: { 'User-Agent': ua, 'Referer': 'https://thedaddy.li/', 'Origin': 'https://thedaddy.li/' }
            });
            const html = await htmlRes.body.text();
            if (!html || html.length < 500) throw new Error('Failed to fetch embed HTML');

            // 2. Extract via Regex
            const data = extractDataFromHtml(html);
            if (!data.chal || !data.src || !data.edge) throw new Error('Failed to extract SRC/EDGE/CHAL');

            // 3. Solve Turnstile
            let turnstileToken = null;
            if (data.tsite) {
                console.log('[DADDYLIVE/TOKEN] Solving Turnstile...');
                turnstileToken = await solveTurnstileMin(browserMgr, embed_url, data.tsite, ua);
            }

            // 4. Get Ticket via undici
            const pValue = generateSignature(data.channel, data.chal.n, data.chal.e);
            const ticketPayload = new URLSearchParams({
                redeem: '1', n: data.chal.n, e: String(data.chal.e), m: data.chal.m, p: pValue
            });
            if (turnstileToken) ticketPayload.append('cf-turnstile-response', turnstileToken);

            const ticketRes = await undiciRequest(embed_url, {
                method: 'POST',
                headers: {
                    'User-Agent': ua, 'Referer': embed_url, 'Origin': requestOrigin,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: ticketPayload.toString()
            });
            const ticketData = await ticketRes.body.json();
            const newTicket = typeof ticketData === 'string' ? ticketData : (ticketData?.ticket || '');
            if (!newTicket) throw new Error('Failed to get ticket');

            // 5. Browser Context for Edge URLs (HTTP/2 Impersonation)
            const ctx = await browserMgr.newContext();
            const page = await ctx.newPage();
            
            try {
                await page.setUserAgent(ua);
                
                const requestOrigin = new URL(embed_url).origin;

                // 5a. Get Token from Edge
                //console.log('[DADDYLIVE/TOKEN] Navigating to embed domain to establish valid origin...');
                await page.goto(embed_url, { waitUntil: 'domcontentloaded', timeout: 5000 });

                const tokenUrl = `${data.edge}/api/playlist-token?slug=${encodeURIComponent(data.channel)}&tk=${encodeURIComponent(newTicket)}`;
                console.log('[DADDYLIVE/TOKEN] Fetching edge token ...');
                
                const tokenData = await page.evaluate(async (url, userAgent, originHeader) => {
                    try {
                        //console.log('[EVALUATE] Starting fetch for:', url);
                        const r = await fetch(url, { 
                            cache: 'no-store', 
                            credentials: 'omit',
                            headers: { 
                                'User-Agent': userAgent,
                                'Referer': `${originHeader}/`,
                                'Origin': originHeader 
                            }
                        });
                        //console.log('[EVALUATE] Fetch completed, status:', r.status);
                        if (!r.ok) {
                            const errorText = await r.text();
                            console.error('[EVALUATE] Request failed:', r.status, errorText);
                            throw new Error(`Token request failed: ${r.status} - ${errorText}`);
                        }
                        const json = await r.json();
                        //console.log('[EVALUATE] JSON parsed successfully');
                        return json;
                    } catch (err) {
                        console.error('[EVALUATE] Fetch error:', err.message);
                        throw err;
                    }
                }, tokenUrl, ua, requestOrigin);

                //console.log('[DADDYLIVE/TOKEN] Token data received:', tokenData);                
                if (!tokenData.token) throw new Error('Failed to get token from edge');

                // // 5b. Get Sealed Playlist from Edge
                // const sealedUrl = `${data.src}?t=${encodeURIComponent(tokenData.token)}&_=${Date.now()}`;
                // console.log('[DADDYLIVE/TOKEN] Fetching sealed playlist ...');
                // //console.log('[DADDYLIVE/TOKEN] Playlist URL:', sealedUrl);
                
                // const sealedText = await page.evaluate(async (url, userAgent, originHeader) => {
                //     try {
                //         const r = await fetch(url, { 
                //             cache: 'no-store', 
                //             credentials: 'omit',
                //             headers: { 
                //                 'User-Agent': userAgent,
                //                 'Referer': `${originHeader}/`,
                //                 'Origin': originHeader 
                //             }
                //         });
                //         if (!r.ok) throw new Error(`Playlist request failed: ${r.status}`);
                //         return await r.text();
                //     } catch (err) {
                //         console.error('[EVALUATE] Playlist fetch error:', err.message);
                //         throw err;
                //     }
                // }, sealedUrl, ua, requestOrigin);

                // // 6. Decrypt locally
                // const cleanPlaylist = decryptPlaylist(sealedText, tokenData.k);

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
            } catch (err) {
                console.error('[DADDYLIVE/TOKEN] Error:', err.message);
                console.error('[DADDYLIVE/TOKEN] Error stack:', err.stack);
                throw err;
            } finally {
                await ctx.close();
            }
        } 
        // ==========================================================================
        // PATH B: TOKEN REFRESH
        // ==========================================================================
        else if (playlist_url && ticket && embed_url) {
            console.log('[DADDYLIVE/TOKEN] Received token refresh request for:', playlist_url);
            const pUrl = new URL(playlist_url);
            const requestOrigin = new URL(embed_url).origin;
            const edgeDomain = `${pUrl.protocol}//${pUrl.host}`;
            const pathParts = pUrl.pathname.split('/').filter(Boolean);
            const slug = pathParts[0] || 'default';
            const ua = req.query.ua || DEFAULT_UA;

            const ctx = await browserMgr.newContext();
            const page = await ctx.newPage();
            try {
                await page.setUserAgent(ua);
                await page.goto(embed_url, { waitUntil: 'domcontentloaded', timeout: 5000 });
                const tokenUrl = `${edgeDomain}/api/playlist-token?slug=${encodeURIComponent(slug)}&tk=${encodeURIComponent(ticket)}`;
                
                const tokenData = await page.evaluate(async (url, userAgent, originHeader) => {
                    const r = await fetch(url, { 
                        cache: 'no-store', credentials: 'omit',
                        headers: { 
                            'User-Agent': userAgent,
                            'Referer': `${originHeader}/`,
                            'Origin': originHeader 
                        }
                    });
                    if (!r.ok) throw new Error(`Token request failed: ${r.status}`);
                    return await r.json();
                }, tokenUrl, ua, requestOrigin);

                if (!tokenData.token) throw new Error('Failed to get token from edge');

                res.json({ ok: true, token: tokenData.token, k: tokenData.k, ttl: tokenData.ttl || 120 });
            } finally {
                await ctx.close();
            }
        } 
        // ==========================================================================
        // PATH C: INVALID REQUEST
        // ==========================================================================
        else {
            res.status(400).json({ ok: false, error: 'Missing embed_url (init) OR playlist_url+ticket (refresh)' });
        }
    } catch (err) {
        console.error('[DADDYLIVE/TOKEN] Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        // CRITICAL: Decrement only when the entire request is truly done
        browserMgr.activeTasks = Math.max(0, (browserMgr.activeTasks || 0) - 1);
    }
}

// ============================================================================
// ENDPOINT 2: /daddylive/playlist
// ============================================================================
export async function handleDaddylivePlaylist(req, res, browserMgr) {
    // CRITICAL: Keep browser alive for the ENTIRE duration of this request
    console.log('[DADDYLIVE/PLAYLIST] Received playlist reload request for:', playlist_url);
    browserMgr.activeTasks = (browserMgr.activeTasks || 0) + 1;
    
    try {
        const { embed_url, playlist_url, token, k } = req.query;
        if (!embed_url || !playlist_url || !token || !k) {
            return res.status(400).json({ ok: false, error: 'Missing parameters' });
        }

        const ua = req.query.ua || DEFAULT_UA;
        const cleanUrl = playlist_url.split('?')[0];
        const sealedUrl = `${cleanUrl}?t=${encodeURIComponent(token)}&_=${Date.now()}`;
        const requestOrigin = new URL(embed_url).origin;

        const ctx = await browserMgr.newContext();
        const page = await ctx.newPage();
        try {
            await page.setUserAgent(ua);
            await page.goto(embed_url, { waitUntil: 'domcontentloaded', timeout: 5000 });
            const sealedText = await page.evaluate(async (url, userAgent, originHeader) => {
                const r = await fetch(url, { 
                    cache: 'no-store', credentials: 'omit',
                    headers: { 
                            'User-Agent': userAgent,
                            'Referer': `${originHeader}/`,
                            'Origin': originHeader 
                        }
                });
                if (!r.ok) throw new Error(`Playlist request failed: ${r.status}`);
                return await r.text();
            }, sealedUrl, ua, requestOrigin);

            const cleanPlaylist = decryptPlaylist(sealedText, k);
            res.json({ ok: true, playlist_text: cleanPlaylist });
        } finally {
            await ctx.close();
        }
    } catch (err) {
        console.error('[DADDYLIVE/PLAYLIST] Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        // CRITICAL: Decrement only when the entire request is truly done
        browserMgr.activeTasks = Math.max(0, (browserMgr.activeTasks || 0) - 1);
    }
}