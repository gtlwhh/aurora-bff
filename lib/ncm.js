/**
 * BFF · 网易云音乐适配层（NeteaseCloudMusicApi 函数式调用）
 *
 * 部署在 Vercel Node runtime / 本地 dev-server 均可运行。
 * 用户凭证：App 端登录后把 cookie 存 IndexedDB，每次请求经
 * `x-ncm-cookie` 头带给 BFF，这里透传给网易云——凭证不落云端。
 */

let ncm = null;
function mod() {
  if (!ncm) ncm = require('NeteaseCloudMusicApi');
  return ncm;
}

/** 统一调用：fn = NCM 模块函数名，params = 查询参数，cookie 从请求头透传 */
async function call(fnName, params = {}, req) {
  const m = mod();
  const fn = m[fnName];
  if (!fn) throw new Error(`NCM 函数不存在: ${fnName}`);
  const cookie = req.headers['x-ncm-cookie'] || '';
  const result = await fn(Object.assign({}, params, cookie ? { cookie } : {}));
  // NCM 函数式返回 { status, body, cookie } —— 业务数据统一在 body
  return result.body !== undefined ? result.body : result;
}

/** 把 NCM 原始响应规范成 App 端期望的形状（对齐桌面端 mapSong 语义） */
function mapSong(item) {
  const artists = (item.ar || item.artists || []).map(a => a.name).join(' / ') || '未知艺术家';
  const al = item.al || item.album || {};
  return {
    id: `netease_${item.id}`,
    provider: 'netease',
    sourceId: `netease:${item.id}`,
    nid: item.id,
    gid: String(item.id),
    title: item.name || '未知曲目',
    artist: artists,
    album: al.name || '',
    albumId: al.picStr || al.pic || '',
    picUrl: al.picUrl || '',
    duration: (item.dt || item.duration || 0),
    hasCover: !!(al.picUrl),
    hasLyric: true
  };
}

async function search(req, res) {
  const keywords = req.query.q || '';
  const limit = Math.min(50, Number(req.query.limit || 30));
  const r = await call('search', { keywords, limit, type: 1 }, req);
  const songs = (r.result && r.result.songs) || r.songs || [];
  res.status(200).json({
    query: keywords,
    provider: 'netease',
    tracks: songs.map(mapSong)
  });
}

async function songDetail(req, res) {
  const r = await call('song_detail', { ids: req.query.ids }, req);
  const songs = (r.songs || []).map(mapSong);
  res.status(200).json({ tracks: songs });
}

async function playUrl(req, res) {
  const nid = req.query.id;
  const level = req.query.level || 'exhigh';
  let r;
  try {
    r = await call('song_url_v1', { id: nid, level }, req);
  } catch (_) {
    r = await call('song_url', { id: nid, br: 320000 }, req);
  }
  const d = (r.data && r.data[0]) || null;
  if (!d || !d.url) return res.status(404).json({ error: '无可播放地址（版权受限或需要 VIP）' });
  res.status(200).json({
    url: d.url,
    type: d.type || 'mp3',
    level: d.level || '',
    size: d.size || 0
  });
}

async function lyric(req, res) {
  const r = await call('lyric', { id: req.query.id }, req);
  res.status(200).json({
    lrc: (r.lrc && r.lrc.lyric) || '',
    tlyric: (r.tlyric && r.tlyric.lyric) || ''
  });
}

async function userPlaylists(req, res) {
  const uid = req.query.uid;
  const r = await call('user_playlist', uid ? { uid } : {}, req);
  const pl = (r.playlist || []).map(p => ({
    id: String(p.id),
    name: p.name || '',
    count: p.trackCount || 0,
    cover: p.coverImgUrl || '',
    special: p.specialType === 5 ? 'like' : undefined,
    system: false
  }));
  res.status(200).json({ playlists: pl, profile: r.profile || null });
}

async function playlistTracks(req, res) {
  const pid = req.query.id;
  const offset = Number(req.query.offset || 0);
  const limit = Math.min(100, Number(req.query.limit || 50));
  const r = await call('playlist_track_all', { id: pid, offset, limit }, req);
  const songs = r.songs || [];
  res.status(200).json({
    total: r.total || songs.length,
    offset,
    hasMore: !!r.more,
    tracks: songs.map(mapSong)
  });
}

/* ---- 扫码登录（App 端展示二维码 + 轮询） ---- */
async function qrCreate(req, res) {
  const keyRes = await call('login_qr_key', {}, req);
  const key = (keyRes.data && keyRes.data.unikey) || keyRes.unikey || '';
  const qrRes = await call('login_qr_create', { key, qrimg: true }, req);
  res.status(200).json({
    key,
    qrimg: (qrRes.data && qrRes.data.qrimg) || qrRes.qrimg || ''
  });
}

async function qrCheck(req, res) {
  const key = req.query.key;
  const r = await call('login_qr_check', { key }, req);
  const out = { code: r.code, message: r.message || '' };
  if (r.code === 803) {
    // 登录成功：把 cookie 原样返回给 App（App 存 IndexedDB，后续请求带回）
    out.cookie = typeof r.cookie === 'string' ? r.cookie : (Array.isArray(r.cookie) ? r.cookie.join('; ') : '');
  }
  res.status(200).json(out);
}

async function loginStatus(req, res) {
  const r = await call('login_status', {}, req);
  const profile = (r.data && r.data.profile) || (r.profile) || null;
  res.status(200).json({
    loggedIn: !!profile,
    user: profile ? {
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      vipType: profile.vipType || 0
    } : null
  });
}

/* ---- 喜欢 / 加歌 / 建歌单（写操作，需要登录 cookie） ---- */
async function like(req, res) {
  const r = await call('like', { id: req.body.id, like: !!req.body.like }, req);
  res.status(200).json({ ok: true, code: r.code });
}

async function addToPlaylist(req, res) {
  const r = await call('playlist_tracks', {
    op: 'add', pid: req.body.pid, tracks: req.body.nid
  }, req);
  const code = r.body && r.body.code;
  res.status(200).json({ ok: code === 200 || code === 502, code });
}

async function createPlaylist(req, res) {
  const r = await call('playlist_create', { name: req.body.name, privacy: '10' }, req);
  res.status(200).json({ ok: true, id: r.playlist && r.playlist.id ? String(r.playlist.id) : '' });
}

module.exports = { search, songDetail, playUrl, lyric, userPlaylists, playlistTracks, qrCreate, qrCheck, loginStatus, like, addToPlaylist, createPlaylist,
  // 供动态推荐路由复用（bff/api/dynamic.js）
  call, mapSong };
