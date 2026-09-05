// clicker.js

/**
 * Starts the smart clicker loop to bypass ad-gates and play buttons.
 * 
 * @param {Object} options
 * @param {import('puppeteer').Page} options.page - The Puppeteer/CloakBrowser page object.
 * @param {Function} options.timeLeft - Function returning remaining time in ms.
 * @param {Function} options.log - Logging function.
 * @returns {{ promise: Promise<void>, stop: Function }}
 */
export function startClickerLoop({ page, timeLeft, log }) {
  let clicking = true;
  let centerClicks = 0;
  let realClicks = 0;

  const promise = (async () => {
    // 1. Wait for the player UI to actually mount before scanning
    try {
      await page.waitForSelector('button, svg.lucide-play, [class*="play"]', { timeout: 5000 });
    } catch {}
    
    // Give it a tiny bit more time to finish layout/animations
    await new Promise(r => setTimeout(r, 500));

    while (clicking && timeLeft() > 2000) {
      try {
        const result = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a'));
          
          const isCenterish = (rect) => {
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;
            return (
              cx > window.innerWidth * 0.2 && cx < window.innerWidth * 0.8 &&
              cy > window.innerHeight * 0.2 && cy < window.innerHeight * 0.8
            );
          };

          // Text-based buttons
          for (const el of buttons) {
            if (el.tagName === 'A') {
              const href = el.getAttribute('href') || '';
              if (href.startsWith('http') && !href.includes(window.location.hostname)) continue;
            }
            const text = (el.innerText || el.textContent || '').toLowerCase().trim();
            if (text && (
              text.includes('verify') || text.includes('play') || 
              text.includes('continue') || text.includes('click') || 
              text.includes('human') || text.includes('start') ||
              text.includes('watch')
            )) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 10 && rect.height > 10) {
                return { box: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, type: 'text-btn' } };
              }
            }
          }

          // Large, center-located SVG buttons
          for (const btn of buttons) {
            const hasSvg = btn.querySelector('svg');
            const text = (btn.innerText || '').trim();
            if (hasSvg && text === '') {
              const rect = btn.getBoundingClientRect();
              if (rect.width >= 40 && rect.height >= 40 && isCenterish(rect)) {
                return { box: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, type: 'svg-center-btn' } };
              }
            }
          }
          
          // Large, central empty buttons
          let maxArea = 0;
          let bestEmptyBtn = null;
          for (const btn of buttons) {
            const hasSvg = btn.querySelector('svg');
            const text = (btn.innerText || '').trim();
            if (text === '' && !hasSvg) {
              const rect = btn.getBoundingClientRect();
              const area = rect.width * rect.height;
              if (rect.width >= 40 && rect.height >= 40 && isCenterish(rect)) {
                if (area > maxArea) {
                  maxArea = area;
                  bestEmptyBtn = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, type: 'empty-center-btn' };
                }
              }
            }
          }
          if (bestEmptyBtn) return { box: bestEmptyBtn };

          return { box: null };
        });

        const box = result?.box ?? null;

        if (box) {
          await page.mouse.move(box.x, box.y, { steps: 5 });
          await new Promise(r => setTimeout(r, 150));
          await page.mouse.click(box.x, box.y);
          log(`[CLICK] Clicked ${box.type} at`, { x: box.x, y: box.y });
          realClicks++;
        } else if (realClicks === 0 && centerClicks < 3) {
          // Fallback with probe
          const probe = await page.evaluate(() => {
            const cx = Math.round(window.innerWidth / 2);
            const cy = Math.round(window.innerHeight / 2);
            const el = document.elementFromPoint(cx, cy);
            const info = { cx, cy, found: false, loading: false, tag: '', text: '' };
            if (!el) return info;
            info.found = true;
            info.tag = el.tagName;
            info.text = (el.innerText || '').trim().slice(0, 80);
            info.cls = String(el.className || '').slice(0, 100);
            const t = info.text.toLowerCase();
            info.loading =
              t.includes('loading') || t.includes('almost ready') ||
              t.includes('optimizing') || t.includes('please wait') ||
              t.includes('buffering') || t.includes('preparing') ||
              t.includes('just a moment') || t.includes('stand by');
            return info;
          }).catch(() => null);

          if (!probe || !probe.found) {
            await page.mouse.click(640, 360);
            centerClicks++;
            log('[CLICK] Center fallback (no probe)');
          } else if (probe.loading) {
            log('[CLICK-PROBE] Loading state, skipping:', probe.text.replace(/\s+/g, ' '));
          } else {
            log('[CLICK-PROBE]', JSON.stringify(probe));
            await page.mouse.click(probe.cx, probe.cy);
            centerClicks++;
            log('[CLICK] Clicked center fallback');
          }
        }
      } catch (e) {
        // Page might be navigating or closed
      }
      
      await new Promise(r => setTimeout(r, 2000)); 
    }
  })();

  return {
    promise,
    stop: () => { clicking = false; }
  };
}