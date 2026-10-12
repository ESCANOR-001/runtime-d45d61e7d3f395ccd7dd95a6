'use strict';

// Loaded inside a user-owned staged Claude copy, before its original entry.
// Never expose arbitrary JavaScript, URLs, credentials, or Electron methods.
const http = require('node:http');
const fs = require('node:fs');
const { timingSafeEqual } = require('node:crypto');
const { app, webContents } = require('electron');

const credentialPath = process.env.REMODEX_CLAUDE_EMBEDDED_CREDENTIAL;
if (!credentialPath) throw new Error('Embedded bridge credential file required.');
const credentialStat = fs.lstatSync(credentialPath);
if (!credentialStat.isFile() || credentialStat.isSymbolicLink() ||
    (process.platform !== 'win32' && (credentialStat.mode & 0o077))) throw new Error('Embedded credentials must be private.');
const credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
if (!/^[\w-]{43}$/.test(credential.token)) throw new Error('Invalid embedded bridge credential.');
const port = Number(process.env.REMODEX_CLAUDE_EMBEDDED_PORT || 10102);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port.');
const equal = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(credential.token)
  && timingSafeEqual(Buffer.from(value), Buffer.from(credential.token));

function renderer() {
  const candidates = webContents.getAllWebContents().filter(contents => {
    if (contents.isDestroyed()) return false;
    try { return new URL(contents.getURL()).origin === 'https://claude.ai'; } catch { return false; }
  });
  if (candidates.length !== 1) throw new Error('Exactly one signed-in Claude Chat window is required.');
  return candidates[0];
}

const operations = {
  async request(input) {
    const contents = renderer();
    const install = require('./renderer.cjs');
    await contents.executeJavaScript(`(${install.toString()})()`);
    return contents.executeJavaScript(`globalThis.__remodexChatBridge.request(${JSON.stringify(input)})`);
  },

};

const server = http.createServer(async (req, res) => {
  const reply = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin) return reply(403, { error: 'Forbidden origin.' });
  if (!equal(req.headers.authorization?.replace(/^Bearer /, ''))) return reply(401, { error: 'Unauthorized.' });
  if (req.url === '/status' && req.method === 'GET') {
    let windowPath = null;
    try { windowPath = new URL(renderer().getURL()).pathname; } catch {}
    return reply(200, { protocol: 1, mode: 'embedded', desktopVersion: app.getVersion(), windowPath });
  }
  if (req.url === '/request' && req.method === 'POST') {
    if (req.headers['content-type'] !== 'application/json') return reply(415, { error: 'JSON required.' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 40000) return reply(413, { error: 'Request too large.' }); chunks.push(chunk); }
      let timer;
      try {
        const result = await Promise.race([operations.request(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude bridge timed out. Check this chat before retrying; delivery may be uncertain.')), 24000); })]);
        return reply(200, result);
      } finally { clearTimeout(timer); }
    } catch (error) { return reply(409, { error: error.message }); }
  }
  return reply(404, { error: 'Unknown operation.' });
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.on('error', () => console.error('[remodex-embedded] listener unavailable'));
app.whenReady().then(() => server.listen(port, '127.0.0.1'));
app.on('will-quit', () => server.close());
