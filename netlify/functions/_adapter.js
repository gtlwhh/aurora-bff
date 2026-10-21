/**
 * Netlify Functions 适配层：把 express 风格的 (req, res) 包成 Netlify handler。
 * 业务逻辑全部复用 lib/ncm.js（与桌面端同源），与 Vercel 版零分叉。
 */
const ncm = require('../../lib/ncm');

/** Netlify event → 伪 express req/res，执行 handler，返回 Netlify 响应 */
async function run(event, handler) {
  const req = {
    method: (event.httpMethod || 'GET').toUpperCase(),
    query: event.queryStringParameters || {},
    headers: event.headers || {},
    body: (() => {
      try { return JSON.parse(event.body || '{}'); } catch (_) { return {}; }
    })()
  };
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(obj) {
      this.headersSent = true;
      this.headers['Content-Type'] = 'application/json';
      return {
        statusCode: this.statusCode,
        headers: this.headers,
        body: JSON.stringify(obj)
      };
    },
    end(data) {
      this.headersSent = true;
      return { statusCode: this.statusCode, headers: this.headers, body: data || '' };
    }
  };
  try {
    const out = await handler(req, res);
    return out || res.json({ ok: true });
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
}

/** 各端点（与 vercel api/ 一一对应） */
const endpoints = {
  health: async (req, res) => res.status(200).json({ ok: true, service: 'aurora-bff', time: Date.now() }),
  search: ncm.search,
  lyric: ncm.lyric,
  stream: ncm.playUrl,
  playlists: async (req, res) => {
    if (req.query.id) return ncm.playlistTracks(req, res);
    return ncm.userPlaylists(req, res);
  },
  qrCreate: ncm.qrCreate,
  qrCheck: ncm.qrCheck,
  loginStatus: ncm.loginStatus,
  dynamic: async (req, res) => {
    // 动态推荐（与 vercel api/dynamic.js 同一套 core/mix.mjs 合并）
    const q = req.query || {};
    const type = q.type || 'fmix';
    let neTracks = [];
    try {
      if (type === 'heartmix' && q.seed) {
        const r = await ncm.call('playmode_intelligence_list', { id: q.seed, pid: q.pid || q.seed }, req);
        neTracks = (r.data || []).slice(0, Math.min(20, Number(q.limit || 6))).map(x => x && x.songInfo).filter(Boolean).map(ncm.mapSong);
      } else {
        const r = await ncm.call('personal_fm', {}, req);
        neTracks = (r.data || []).map(ncm.mapSong).filter(Boolean);
      }
    } catch (err) {
      console.warn('[bff-dynamic] 网易云侧失败:', err.message);
    }
    let merge;
    try { merge = await import('../../core/mix.mjs'); }
    catch (_) { merge = { mergeMixRecommendations: ({ ne }) => ({ tracks: ne, sides: ne.length ? ['netease'] : [] }) }; }
    const { tracks, sides } = merge.mergeMixRecommendations({ ne: neTracks, qq: [] });
    res.status(200).json({ tracks, sides, cursor: { seed: q.seed || null, pid: q.pid || null }, exhausted: tracks.length === 0 });
  }
};

module.exports = { run, endpoints };
