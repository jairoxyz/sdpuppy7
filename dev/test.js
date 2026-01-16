import { getSrc } from '../plresolver.js';


const USER_AGENT = process.platform === 'linux' ? 
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36" :
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
  
const websites = [
  { url: 'https://modistreams.org/embed/english-fa-cup/2026-01-12/liv-bar',
    referer: 'https://ppv.to/',
    timeout: 5_000
  },
  { url: 'https://embedsports.top/embed/admin/ppv-liverpool-vs-barnsley/1',
    referer: 'https://streamed.pk/',
    timeout: 5_000
  }  
];


async function main() {
  
  for (const site of websites) {

        console.log("Embed url: " + site.url)
        let finsrcs = await getSrc(site.url, site.referer, site.timeout)
        console.log(JSON.stringify(finsrcs));
      
  }
}

main();