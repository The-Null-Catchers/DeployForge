// DeployForge sample application. Dependency-free (Node.js standard library).
//
// Behavior is driven by release.json so that each git commit is a distinct,
// visibly different release:
//   {"version":"A","color":"#2563eb","healthy":true,"crashOnStart":false}
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const release = JSON.parse(fs.readFileSync(path.join(__dirname, 'release.json'), 'utf8'));
const port = Number(process.env.PORT || 3000);
const startedAt = new Date();
const buildLabel = process.env.BUILD_LABEL || 'none';

if (release.crashOnStart) {
  console.error(`release ${release.version}: crashOnStart=true, exiting with status 3`);
  process.exit(3);
}

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page() {
  const envNames = Object.keys(process.env).filter((k) => /^[A-Z_]+$/.test(k)).sort();
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sample app ${escapeHtml(release.version)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:0;background:${escapeHtml(release.color)};color:#fff;display:grid;place-items:center;min-height:100vh}
main{background:rgba(0,0,0,.25);padding:2rem 3rem;border-radius:12px;max-width:40rem}code{font-family:ui-monospace,monospace}</style></head>
<body><main><h1>Sample app &mdash; version ${escapeHtml(release.version)}</h1>
<p>Greeting: <strong>${escapeHtml(process.env.GREETING || '(GREETING not set)')}</strong></p>
<p>Build label: <code>${escapeHtml(buildLabel)}</code></p>
<p>Started: <code>${startedAt.toISOString()}</code></p>
<p>Environment variable <em>names</em> present (values are never shown): <code>${escapeHtml(envNames.join(', '))}</code></p>
</main></body></html>`;
}

// Minimal RFC 6455 text-frame echo, used to verify WebSocket proxying.
function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (buf) => {
    if (buf.length < 6) return;
    const opcode = buf[0] & 0x0f;
    if (opcode === 0x8) return socket.end();
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) return socket.destroy();
    const mask = buf.subarray(off, off + 4);
    const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
    const text = Buffer.from(`echo(${release.version}): ${data.toString('utf8')}`);
    if (text.length > 125) return socket.destroy();
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    const ok = release.healthy !== false;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: ok ? 'ok' : 'failing', version: release.version }));
  }
  if (url.pathname === '/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ version: release.version, buildLabel, startedAt: startedAt.toISOString() }));
  }
  if (url.pathname === '/headers') {
    // Shows forwarding headers added by the proxy (no cookies/authorization).
    const pick = ['host', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(Object.fromEntries(pick.map((h) => [h, req.headers[h] ?? null]))));
  }
  if (url.pathname === '/') {
    log(`GET / version=${release.version}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page());
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});
server.on('upgrade', handleUpgrade);

server.listen(port, '0.0.0.0', () => {
  log(`sample app version ${release.version} listening on 0.0.0.0:${port} (healthy=${release.healthy !== false})`);
});
const heartbeat = setInterval(() => log(`heartbeat version=${release.version} uptime=${Math.round(process.uptime())}s`), 30000);

function shutdown(sig) {
  log(`received ${sig}, draining connections`);
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
