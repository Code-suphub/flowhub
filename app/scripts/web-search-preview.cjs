// Disposable read-only UI fixture. Never connects to FlowHub's config/database.
// Run: node scripts/web-search-preview.cjs, then open the printed URL.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../ui');
const config = { core: {}, plugins: {
  web: { enabled: true, settings: { items: Array.from({ length: 10000 }, (_, id) => ({
    id: String(id), title: `GitHub 工具 ${id}`, url: `https://example.test/${id}`, note: '开发文档', icon: '🌐'
  })) } }, app: { enabled: false }, clipboard: { enabled: false }, memo: { enabled: false }, tools: { enabled: false }
} };
http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (pathname.startsWith('/__weborg/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(pathname === '/__weborg/config' ? config : { ok: true, applications: [], records: [] }));
    return;
  }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/search.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(0, '127.0.0.1', function () { console.log(`http://127.0.0.1:${this.address().port}/search.html`); });
