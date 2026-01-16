
// tls-probe.js (or place at the top of your server file for quick testing)
import tls from 'node:tls';
import { URL } from 'node:url';

/**
 * Probe TLS/ALPN to a host (or URL) and return negotiated details.
 * Forces TLS 1.2 to match your working curl scenario.
 *
 * @param {string} hostOrUrl - e.g., "lb8.strmd.top" or "https://lb8.strmd.top/..."
 */
export async function probeTls(hostOrUrl) {
  const hostname = (() => {
    try {
      // If it's a URL, extract hostname
      const u = new URL(hostOrUrl);
      return u.hostname;
    } catch {
      // Otherwise assume it's a hostname
      return hostOrUrl;
    }
  })();

  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: hostname,
        port: 443,                 // <-- REQUIRED
        servername: hostname,      // SNI
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        ALPNProtocols: ['h2', 'http/1.1'], // mirror your intended client
        // (Optional) If you later decide to pin ciphers, add `ciphers: '...'` here
        // timeout to avoid hanging forever
        timeout: 8000,
      },
      () => {
        const info = {
          protocol: socket.getProtocol(), // 'TLSv1.2'
          alpn: socket.alpnProtocol,      // 'h2' | 'http/1.1' | false
          cipher: socket.getCipher(),     // { name, standardName (newer Node), version }
          authorized: socket.authorized,
          authorizationError: socket.authorizationError || null,
          servername: hostname,
        };
        socket.end();
        resolve(info);
      }
    );
    socket.on('timeout', () => {
      socket.destroy(new Error('TLS probe timeout'));
    });
    socket.on('error', reject);
  });
}

// Example usage:
(async () => {
  const info = await probeTls('https://lb8.strmd.top/secure/KscEMepEfeoHxQjApbBfSUClBMBjsxaA/echo/stream/masters-snooker-pick3/1/playlist.m3u8');
  console.log(JSON.stringify(info));
})();


