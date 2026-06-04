
const TARGET_URL = 'https://vidcore.net/tv/224941/1/1';
const USER_AGENT =
  process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';


//--------------------------------------------
// MAIN
//--------------------------------------------
(async () => {

   let _launch;
    async function getLaunch() {
    if (!_launch) ({ launch: _launch } = await import('cloakbrowser/puppeteer'));
    return _launch;
    }


    const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            `--fingerprint=12345`,
        ];

    const launch = await getLaunch();

    const browser = await launch({
        // Essential flags
        headless: false,              // JSD may detect headless Chromium [[1]]
        //proxy: 'http://user:pass@residential-proxy:port',  // Residential IP required
        geoip: true,                  // Auto-match timezone/locale to proxy IP [[1]]
        humanize: true,               // Human-like mouse/keyboard behavior [[1]]
        humanPreset: 'careful',
        
        // Optional: fixed fingerprint for returning visitor behavior
        args: args,
    });

  const page = await browser.newPage();
  //await page.setUserAgent(USER_AGENT);

  
  await page.setRequestInterception(true);

  page.on('request', req => {
    const urlStr = req.url();
    if (urlStr.startsWith('data:') ||
          urlStr.includes('google') ||
          urlStr.includes('podley') ||
          urlStr.includes('wsrv.nl') ||
          urlStr.includes('deuxseethe') ||
          urlStr.includes('unwrapsstow')
        ) {
        return req.abort();
      }
    req.continue();
  });

  
  let resolveM3U8;
  const m3u8Promise = new Promise(resolve => {
    resolveM3U8 = resolve;
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const req = res.request();

      console.log(`[${req.method()}] ${url} ${res.status()}`);

      // ✅ THIS is the key
      if (url.includes('.m3u8')) {
        console.log('\n🎯 FOUND M3U8:', url);

        resolveM3U8(url);
      }

      // Optional: inspect POST responses
      if (req.method() === 'POST') {
        const text = await res.text();

        if (text.includes('.m3u8')) {
          console.log('\n🎯 M3U8 in POST:', text);
          resolveM3U8(text);
        }
      }

    } catch (e) {}
  });


  // === Load page ===
  await page.goto('https://vidcore.net/tv/224941/1/2', {
    waitUntil: 'networkidle2'
  });

 
 // ✅ WAIT until m3u8 is found
  const m3u8Url = await m3u8Promise;

  console.log('\n✅ FINAL RESULT:', m3u8Url);

  await browser.close();


})();
