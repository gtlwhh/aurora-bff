/**
 * BFF 本地开发服务器（不经 Vercel，直接 Node 起服务）
 * 用法：node bff/dev-server.js [port]   默认 3001
 * 供移动端 UI 开发期直连（BFF Base = http://127.0.0.1:3001）
 */
const http = require('http');
const url = require('url');
const ncm = require('./lib/ncm');

const routes = {
  '/api/health': (req, res) => res.status ? res.status(200).json({ ok: true }) : res.end(JSON.stringify({ ok: true })),
  '/api/search': ncm.search,
  '/api/lyric': ncm.lyric,
  '/api/stream': ncm.playUrl,
  '/api/playlists': ncm.playlistTracks || ncm.userPlaylists,
  '/api/login/qr-create': ncm.qrCreate,
  '/api/login/qr-check': ncm.qrCheck,
  '/api/login/status': ncm.loginStatus,
  '/api/dynamic/next': require('./api/dynamic')
};

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const path = u.pathname.replace(/\/+$/, '') || '/api/health';
  // 统一 res.status
  if (!res.status) res.status = (c) => { res.statusCode = c; return res; };
  if (!res.json) res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ncm-cookie');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  req.query = u.query;
  req.body = {};

  const handler = routes[path];
  if (!handler) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found', path })); }
  try {
    await handler(req, res);
  } catch (err) {
    console.error('[bff]', path, err.message);
    if (!res.headersSent) { res.statusCode = 502; res.end(JSON.stringify({ error: err.message })); }
  }
});

// 本地开发：node dev-server.js [port]（默认 3001，绑 127.0.0.1）
// Render 云端：平台注入 PORT 环境变量 → 自动绑 0.0.0.0（同一份代码双端跑）
const isCloud = !!process.env.PORT;
const port = Number(process.env.PORT || process.argv[2] || 3001);
const host = isCloud ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => console.log(`[BFF ${isCloud ? 'cloud' : 'dev'}] http://${host === '0.0.0.0' ? '<host>' : host}:${port}`));
