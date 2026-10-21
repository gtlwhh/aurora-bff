/**
 * 极光音乐 BFF · Cloudflare Workers (Hono)
 *
 * 设计要点：
 *  - 网易云走"裸 /api/ 接口"（无需 weapi 加密），纯 fetch，零 Node 依赖
 *  - cookie 由客户端保管，经 x-ncm-cookie 头透传（服务端不落任何用户凭证）
 *  - QQ 侧维持"单侧降级"占位（serverless 适配待接），合并逻辑复用共享 core/mix.mjs
 *  - 契约与桌面 server / 移动端 bff.js 完全一致（路径式 + 查询式双兼容）
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import QRCode from 'qrcode';
import { mergeMixRecommendations } from '../../core/mix.mjs';

const NCM = 'https://music.163.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const app = new Hono();
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'x-ncm-cookie', 'x-qq-session'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 86400
}));

/* ---------------- 网易云 fetch 封装 ---------------- */

function ncmHeaders(cookie) {
  return {
    'User-Agent': UA,
    'Referer': NCM,
    'Origin': NCM,
    ...(cookie ? { 'Cookie': cookie } : {})
  };
}

async function ncmGet(path, params, cookie) {
  const u = new URL(NCM + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: ncmHeaders(cookie) });
  return res.json();
}

async function ncmPost(path, params, cookie) {
  const csrf = (cookie || '').match(/__csrf=([^;]+)/)?.[1] || '';
  const body = new URLSearchParams({ ...params, csrf_token: csrf });
  const res = await fetch(NCM + path, {
    method: 'POST',
    headers: { ...ncmHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return res.json();
}

/** mapSong：与桌面 server / bff 完全一致的字段契约 */
function mapSong(item) {
  if (!item) return null;
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
    albumId: String(al.picStr || al.pic || al.id || ''),
    picUrl: (al.picUrl || '').replace(/^http:/, 'https:'),
    duration: item.dt || item.duration || 0,
    hasCover: !!al.picUrl,
    hasLyric: true
  };
}

const cookieOf = (c) => c.req.header('x-ncm-cookie') || '';
const json = (c, obj, status = 200) => c.json(obj, status);

/* ---------------- weapi 加密（纯 JS，Workers 兼容） ----------------
 * AES-128-CBC ×2（WebCrypto）+ RSA 无填充（BigInt modPow），端口自 NeteaseCloudMusicApi。
 * 用于被网易云上锁的端点（如登录二维码 unikey）。
 */
const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud';
const WEAPI_IV = '0102030405060708';
const WEAPI_PUBKEY = '010001';
const WEAPI_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7a0';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function hexify(str) {
  return [...str].map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

async function aesB64(text, key) {
  const enc = new TextEncoder();
  const ck = await crypto.subtle.importKey('raw', enc.encode(key), 'AES-CBC', false, ['encrypt']);
  const buf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: enc.encode(WEAPI_IV) }, ck, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function weapi(object) {
  const text = JSON.stringify(object);
  const secretKey = [...crypto.getRandomValues(new Uint8Array(16))].map(i => BASE62[i % 62]).join('');
  const params = await aesB64(await aesB64(text, WEAPI_PRESET_KEY), secretKey);
  const encSecKey = modPow(BigInt('0x' + hexify([...secretKey].reverse().join(''))), BigInt('0x' + WEAPI_PUBKEY), BigInt('0x' + WEAPI_MODULUS)).toString(16).padStart(256, '0');
  return { params, encSecKey };
}

async function ncmWeapiPost(path, object, cookie) {
  const { params, encSecKey } = await weapi(object);
  const csrf = (cookie || '').match(/__csrf=([^;]+)/)?.[1] || '';
  const body = new URLSearchParams({ params, encSecKey, csrf_token: csrf });
  const res = await fetch(NCM + path, {
    method: 'POST',
    headers: { ...ncmHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return res.json();
}

/* ---------------- 路由 ---------------- */

app.get('/api/health', (c) => json(c, { ok: true, service: 'aurora-bff-worker', time: Date.now() }));

app.get('/api/search', async (c) => {
  const q = c.req.query('q') || '';
  const limit = Math.min(50, Number(c.req.query('limit') || 30));
  if (!q.trim()) return json(c, { query: q, tracks: [] });
  try {
    const r = await ncmGet('/api/search/get/web', { s: q, type: 1, offset: 0, limit, total: true }, cookieOf(c));
    const songs = (r.result && r.result.songs) || [];
    return json(c, { query: q, provider: 'netease', tracks: songs.map(mapSong).filter(Boolean) });
  } catch (err) {
    return json(c, { error: err.message, tracks: [] }, 502);
  }
});

app.get('/api/song-detail', async (c) => {
  const ids = (c.req.query('ids') || '').split(',').filter(Boolean);
  if (!ids.length) return json(c, { tracks: [] });
  try {
    const r = await ncmGet('/api/song/detail', { ids: JSON.stringify(ids.map(Number)) }, cookieOf(c));
    return json(c, { tracks: (r.songs || []).map(mapSong).filter(Boolean) });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

/** 歌词：路径式（移动端）+ 查询式（桌面旧契约）双兼容 */
async function lyricHandler(c, id) {
  if (!id) return json(c, { error: '缺少歌曲 id' }, 400);
  try {
    const r = await ncmGet('/api/song/lyric', { id, lv: 1, kv: 1, tv: -1 }, cookieOf(c));
    return json(c, { lrc: (r.lrc && r.lrc.lyric) || '', tlyric: (r.tlyric && r.tlyric.lyric) || '' });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
}
app.get('/api/lyric/:provider/:id', (c) => {
  const { provider, id } = c.req.param();
  if (provider !== 'netease') return json(c, { error: `provider ${provider} 尚未接入 worker`, lrc: '' }, 501);
  return lyricHandler(c, id);
});
app.get('/api/lyric', (c) => lyricHandler(c, c.req.query('id')));

/** 播放直链：返回可播 URL（App 原生播放器拉流） */
async function streamHandler(c, id) {
  if (!id) return json(c, { error: '缺少歌曲 id' }, 400);
  const br = Number(c.req.query('br') || 320000);
  try {
    const r = await ncmGet('/api/song/enhance/player/url', { ids: JSON.stringify([Number(id)]), br }, cookieOf(c));
    const d = (r.data && r.data[0]) || null;
    if (!d || !d.url) return json(c, { error: d && d.msg ? d.msg : '无可播放地址（可能 VIP/版权受限）' }, 404);
    return json(c, { url: d.url.replace(/^http:/, 'https:'), type: d.type, size: d.size, level: d.level, fee: d.fee });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
}
app.get('/api/stream/:provider/:id', (c) => {
  const { provider, id } = c.req.param();
  if (provider !== 'netease') return json(c, { error: `provider ${provider} 尚未接入 worker` }, 501);
  return streamHandler(c, id);
});
app.get('/api/stream', (c) => streamHandler(c, c.req.query('id')));

/** 用户歌单（含"我喜欢" specialType=5） */
app.get('/api/playlists', async (c) => {
  const id = c.req.query('id');
  const cookie = cookieOf(c);
  try {
    if (id) {                                    // 歌单详情曲目
      const d = await ncmGet('/api/playlist/detail', { id, n: 0 }, cookie);
      const pl = d.playlist || {};
      const all = (pl.trackIds || []).map(x => x.id);
      const offset = Math.max(0, Number(c.req.query('offset') || 0));
      const limit = Math.min(100, Number(c.req.query('limit') || 50));
      const page = all.slice(offset, offset + limit);
      let tracks = [];
      if (page.length) {
        const s = await ncmGet('/api/song/detail', { ids: JSON.stringify(page) }, cookie);
        tracks = (s.songs || []).map(mapSong).filter(Boolean);
      }
      // 按歌单内原顺序对齐
      const byId = new Map(tracks.map(t => [t.nid, t]));
      tracks = page.map(i => byId.get(i)).filter(Boolean);
      return json(c, { total: all.length, offset, hasMore: offset + limit < all.length, tracks });
    }
    // 歌单列表：先取账号拿 uid
    const acc = await ncmGet('/api/nuser/account/get', {}, cookie);
    const uid = acc.profile && acc.profile.userId;
    if (!uid) return json(c, { error: '未登录：请先扫码', loggedIn: false }, 401);
    const r = await ncmGet('/api/user/playlist', { uid, limit: 100, offset: 0 }, cookie);
    const pl = (r.playlist || []).map(p => ({
      id: String(p.id),
      name: p.name || '',
      count: p.trackCount || 0,
      cover: (p.coverImgUrl || '').replace(/^http:/, 'https:'),
      special: p.specialType === 5 ? 'like' : undefined,
      system: false
    }));
    return json(c, { playlists: pl, profile: acc.profile || null, provider: 'netease' });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

/** 歌单曲目（桌面端路径别名） */
app.get('/api/playlist/tracks', async (c) => {
  const id = c.req.query('id');
  const offset = Math.max(0, Number(c.req.query('offset') || 0));
  const limit = Math.min(100, Number(c.req.query('limit') || 50));
  const cookie = cookieOf(c);
  try {
    const d = await ncmGet('/api/playlist/detail', { id, n: 0 }, cookie);
    const all = ((d.playlist && d.playlist.trackIds) || []).map(x => x.id);
    const page = all.slice(offset, offset + limit);
    let tracks = [];
    if (page.length) {
      const s = await ncmGet('/api/song/detail', { ids: JSON.stringify(page) }, cookie);
      tracks = (s.songs || []).map(mapSong).filter(Boolean);
    }
    const byId = new Map(tracks.map(t => [t.nid, t]));
    tracks = page.map(i => byId.get(i)).filter(Boolean);
    return json(c, { total: all.length, offset, hasMore: offset + limit < all.length, tracks });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

/** 动态推荐：fmix 私人漫游 / heartmix 心动模式（QQ 侧待接，单侧降级不报错） */
app.get('/api/dynamic/next', async (c) => {
  const type = c.req.query('type') || 'fmix';
  const limit = Math.min(20, Number(c.req.query('limit') || 6));
  const cookie = cookieOf(c);
  let neTracks = [];
  try {
    if (type === 'heartmix' && c.req.query('seed')) {
      const r = await ncmPost('/api/playmode/intelligence/list', {
        songId: c.req.query('seed'),
        playlistId: c.req.query('pid') || c.req.query('seed'),
        type: 'fromPlayOne'
      }, cookie);
      neTracks = ((r.data || []).slice(0, limit)).map(x => x && x.songInfo).filter(Boolean).map(mapSong).filter(Boolean);
    } else {
      const r = await ncmGet('/api/personal_fm/', {}, cookie);
      neTracks = (r.data || []).map(mapSong).filter(Boolean);
    }
  } catch (err) {
    console.warn('[dynamic] 网易云侧失败:', err.message);
  }
  const qqTracks = [];                       // TODO：QQ serverless 适配接入后填充
  const { tracks, sides } = mergeMixRecommendations({ ne: neTracks, qq: qqTracks });
  return json(c, {
    tracks, sides,
    cursor: { seed: c.req.query('seed') || null, pid: c.req.query('pid') || null },
    exhausted: tracks.length === 0
  });
});

/* ---- 扫码登录（cookie 全程只在客户端保管） ---- */

app.get('/api/login/qr-create', async (c) => {
  try {
    const r = await ncmPost('/api/login/qrcode/unikey', { type: 3 }, '');
    const key = (r.unikey || (r.data && r.data.unikey) || '');
    if (!key) return json(c, { error: r.message || '获取二维码 key 失败', code: r.code }, 502);
    const svg = await QRCode.toString(`https://music.163.com/login?codekey=${key}`, {
      type: 'svg', margin: 1, width: 220, color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    const qrimg = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    return json(c, { key, qrimg });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

app.get('/api/login/qr-check', async (c) => {
  const key = c.req.query('key');
  if (!key) return json(c, { error: '缺少 key' }, 400);
  try {
    const body = new URLSearchParams({ key, type: '3', csrf_token: '' });
    const res = await fetch(`${NCM}/api/login/qrcode/client/login`, {
      method: 'POST',
      headers: ncmHeaders(''),
      body
    });
    const r = await res.json();
    const out = { code: r.code, message: r.message || '' };
    if (r.code === 803) {
      // 登录成功：从 Set-Cookie 收齐凭证交给客户端保管
      const set = typeof res.headers.getAll === 'function'
        ? res.headers.getAll('set-cookie')
        : [...res.headers.entries()].filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
      out.cookie = set.map(line => line.split(';')[0]).join('; ');
    }
    return json(c, out);
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

app.get('/api/login/status', async (c) => {
  try {
    const r = await ncmGet('/api/nuser/account/get', {}, cookieOf(c));
    const profile = r.profile || null;
    return json(c, { loggedIn: !!profile, profile: profile ? { userId: profile.userId, nickname: profile.nickname, avatarUrl: profile.avatarUrl, vipType: profile.vipType } : null });
  } catch (err) {
    return json(c, { loggedIn: false, error: err.message });
  }
});

/* ---- 写操作（全部 cookie 鉴权） ---- */

app.post('/api/like', async (c) => {
  const { nid, like } = await c.req.json().catch(() => ({}));
  if (!nid) return json(c, { error: '缺少歌曲 id' }, 400);
  try {
    const r = await ncmPost('/api/radio/like', { alg: 'itembased', trackId: nid, like: like ? 'true' : 'false' }, cookieOf(c));
    return json(c, { ok: r.code === 200, code: r.code });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

app.post('/api/track/add-to', async (c) => {
  const { pid, nid } = await c.req.json().catch(() => ({}));
  if (!pid || !nid) return json(c, { error: '缺少歌单或歌曲 id' }, 400);
  try {
    const r = await ncmPost('/api/playlist/manipulate/tracks', { op: 'add', pid, tracks: nid }, cookieOf(c));
    return json(c, { ok: r.code === 200 || r.code === 502, code: r.code, message: r.message || '' });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

app.post('/api/playlist/create', async (c) => {
  const { name } = await c.req.json().catch(() => ({}));
  if (!name) return json(c, { error: '缺少歌单名' }, 400);
  try {
    const r = await ncmPost('/api/playlist/create', { name: String(name).slice(0, 40), privacy: '10' }, cookieOf(c));
    return json(c, { ok: r.code === 200, id: r.id ? String(r.id) : '' });
  } catch (err) {
    return json(c, { error: err.message }, 502);
  }
});

app.notFound((c) => json(c, { error: 'not found', path: new URL(c.req.url).pathname }, 404));

export default app;
