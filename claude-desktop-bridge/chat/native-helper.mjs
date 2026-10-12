import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const nativeBinary = () => process.env.REMODEX_DESKTOP_HELPER || path.join(directory, '../native/target/release', process.platform === 'win32' ? 'remodex-desktop-helper.exe' : 'remodex-desktop-helper');

// No shell, account credentials, or network listener. Each primitive has a bounded
// lifetime. A failed mutation is never retried through another driver.
export function nativeCall(request, { binary = nativeBinary(), timeout = 15000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 24 * 1024 * 1024) return reject(new Error('Native request is too large.'));
    const child = spawnProcess(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false, bytes = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill(); finish(new Error('Native Desktop action timed out. Inspect Desktop before retrying.'));
    }, timeout);
    child.on('error', () => finish(new Error('The native Desktop helper is unavailable. Build or install it for this operating system.')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 24 * 1024 * 1024) { child.kill(); finish(new Error('Native Desktop response is too large.')); return; }
      chunks.push(chunk);
    });
    child.on('close', code => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.ok !== true) throw new Error(response.error || 'Native Desktop action failed.');
        if (code !== 0) throw new Error('Native Desktop helper exited before confirming the result.');
        finish(null, response.result);
      } catch (error) { finish(error instanceof SyntaxError ? new Error('Native Desktop returned an incomplete response.') : error); }
    });
    child.stdin.end(input);
  });
}
