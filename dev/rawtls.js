// Raw TLS HTTP/1.1 GET that mimics your working curl request
import * as tls from 'node:tls';

function getLikeCurlRaw(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname;
    const port = Number(u.port || 443);
    const path = u.pathname + u.search;

    // EXACT header set & casing as in your curl trace:
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36`,
      `Accept: */*`,
      `Referer: https://embedsports.top/`,
      `Origin: https://embedsports.top`,
      `\r\n`
    ];

    const reqBuf = Buffer.from(lines.join('\r\n'), 'utf8');

    const socket = tls.connect({
      host,
      port,
      servername: host,    // SNI
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],  // mirror curl trace where server accepted http/1.1
      rejectUnauthorized: true,
    });

    let timer = setTimeout(() => {
      socket.destroy(new Error(`Timeout ${timeoutMs} ms`));
    }, timeoutMs);

    const chunks = [];
    socket.once('secureConnect', () => {
      // Optional debug:
      console.log('ALPN:', socket.alpnProtocol, 'Cipher:', socket.getCipher(), 'Protocol:', socket.getProtocol());
      socket.write(reqBuf);
    });

    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('end', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      const raw = buf.toString('utf8');

      // Basic HTTP response parsing
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd < 0) return resolve({ status: 0, headers: {}, body: raw, finalUrl: url });

      const headerText = raw.slice(0, headerEnd);
      const body = raw.slice(headerEnd + 4);

      const statusLine = headerText.split('\r\n')[0] || '';
      const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      const status = m ? parseInt(m[1], 10) : 0;

      const headers = {};
      headerText.split('\r\n').slice(1).forEach(line => {
        const i = line.indexOf(':');
        if (i > 0) {
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          headers[k] = v;
        }
      });

      resolve({ status, headers, body, finalUrl: url, httpVersion: '1.1', alpn: socket.alpnProtocol || 'unknown' });
    });
  });
}

// Example usage:
(async () => {
  const r = await getLikeCurlRaw('https://lb3.strmd.top/secure/uSBvNsrQrXNyGnmoLsyCSoZByRmAlVUe/echo/stream/atp-500-rotterdam-atp-250-buenos-aires-tn-1/1/playlist.m3u8');
  console.log(r.status, r.headers);
  console.log(r.body.slice(0, 500));
})();