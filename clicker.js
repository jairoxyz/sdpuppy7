// clicker.js

export function startClickerLoop({ page, timeLeft, log }) {
  let clicking = true;
  let ticks = 0;
  let blindClicks = 0;
  let realClicks = 0;

  const promise = (async () => {
    log('[CLICK] Starting loop...');
    
    // Let the initial page scripts settle
    await new Promise(r => setTimeout(r, 1000)); 

    while (clicking && timeLeft() > 2000) {
      ticks++;
      
      try {
        // 🚀 PHASE 1: Blind clicks to trigger ad chains (Ticks 1 & 2)
        if (ticks <= 2) {
           log(`[CLICK] Tick ${ticks}: Firing blind center click to clear ad gates...`);
           await page.mouse.click(640, 360);
           blindClicks++;
           await new Promise(r => setTimeout(r, 2000));
           continue; 
        }

        // 🎯 PHASE 2: Smart DOM Scanner (Tick 3+)
        // Wrapped in a 3-second timeout to prevent lock.wasm from freezing the loop
        const result = await Promise.race([
          page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a, [tabindex="0"]'));
            
            const isCenterish = (rect) => {
              const cx = rect.x + rect.width / 2;
              const cy = rect.y + rect.height / 2;
              return (
                cx > window.innerWidth * 0.15 && cx < window.innerWidth * 0.85 &&
                cy > window.innerHeight * 0.15 && cy < window.innerHeight * 0.85
              );
            };

            // Helper to read aria-label and title (Fixes JWPlayer invisible text)
            const getElText = (el) => {
              return (
                el.innerText || el.textContent || 
                el.getAttribute('aria-label') || el.getAttribute('title') || ''
              ).toLowerCase().replace(/\s+/g, ' ').trim();
            };

            // Priority 1: Text / Aria-label buttons (Verify, Play, Continue)
            for (const el of buttons) {
              if (el.tagName === 'A') {
                const href = el.getAttribute('href') || '';
                if (href.startsWith('http') && !href.includes(window.location.hostname)) continue;
              }
              const text = getElText(el);
              if (text && (
                text.includes('verify') || text.includes('play') || text.includes('continue') || 
                text.includes('click') || text.includes('human') || text.includes('start') || text.includes('watch')
              )) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 10 && rect.height > 10) {
                  return { box: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, type: 'text-btn' } };
                }
              }
            }

            // Priority 2: JWPlayer / SVG Center Buttons
            for (const btn of buttons) {
              const hasSvg = btn.querySelector('svg');
              const text = getElText(btn);
              // Catch JWPlayer's specific display icon class
              const isJwDisplay = btn.classList && btn.classList.contains('jw-icon-display');
              
              if ((hasSvg && text === '') || isJwDisplay) {
                const rect = btn.getBoundingClientRect();
                if (rect.width >= 24 && rect.height >= 24 && isCenterish(rect)) {
                  return { box: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, type: 'svg-center-btn' } };
                }
              }
            }
            
            // Priority 3: Large Empty Center Buttons (CSS shapes)
            let maxArea = 0;
            let bestEmptyBtn = null;
            for (const btn of buttons) {
              const hasSvg = btn.querySelector('svg');
              const text = getElText(btn);
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
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3000))
        ]).catch(e => {
          return { box: null, error: e?.message };
        });

        if (result?.error) {
          log('[CLICK] Evaluate failed/timed out:', result.error);
        }

        const box = result?.box ?? null;

        if (box) {
          await page.mouse.move(box.x, box.y, { steps: 5 });
          await new Promise(r => setTimeout(r, 150));
          await page.mouse.click(box.x, box.y);
          log(`[CLICK] Clicked ${box.type} at`, { x: box.x, y: box.y });
          realClicks++;
        } else if (realClicks === 0 && blindClicks < 5) {
          // If scanner finds nothing, keep poking the center to force ads to close
          await page.mouse.click(640, 360);
          blindClicks++;
          log('[CLICK] Scanner found nothing, firing center fallback');
        }

      } catch (e) {
        log('[CLICK ERROR]', e.message);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
    log('[CLICK] Loop exited.');
  })();

  return {
    promise,
    stop: () => { 
      clicking = false; 
      log('[CLICKER] Stop called.'); 
    }
  };
}