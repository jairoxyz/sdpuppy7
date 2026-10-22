export function startClickerLoop({ page, timeLeft, log }) {
  let clicking = true;
  let ticks = 0;

  const promise = (async () => {
    log('[CLICKER] Module loaded and promise started.');
    
    // Basic wait just to let the page settle
    await new Promise(r => setTimeout(r, 1000)); 

    while (clicking) {
      ticks++;
      
      // 1. Check if timeLeft is actually working
      const tl = typeof timeLeft === 'function' ? timeLeft() : 'NOT A FUNCTION';
      log(`[CLICKER TICK ${ticks}] timeLeft: ${tl}`);
      
      if (typeof tl === 'number' && tl < 2000) {
         log('[CLICKER] timeLeft is too low, breaking loop immediately.');
         break;
      }

      try {
        log('[CLICKER] Step 1: Entering try block.');
        
        log('[CLICKER] Step 2: Testing page.evaluate...');
        const url = await page.evaluate(() => window.location.href);
        log(`[CLICKER] Step 3: Evaluate succeeded. URL: ${url.slice(0, 50)}...`);

        log('[CLICKER] Step 4: Testing page.mouse.click...');
        await page.mouse.click(640, 360);
        log('[CLICKER] Step 5: Click succeeded!');
        
      } catch (e) {
        log(`[CLICKER ERROR] ${e.message}`);
      }
      
      log('[CLICKER] Step 6: Waiting 2 seconds...');
      await new Promise(r => setTimeout(r, 2000));
    }
    log('[CLICKER] Loop exited.');
  })();

  return { 
    promise, 
    stop: () => { 
      clicking = false; 
      log('[CLICKER] Stop called.'); 
    } 
  };
}