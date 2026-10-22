'use strict';
/**
 * QQ 音乐平台适配器（SourceAdapter 平台补充实现）
 *
 * 搜索、取链、歌词、歌单全部走本地内嵌的 QQ 音乐 API 服务
 * （server/lib/qq-api.js，直连 QQ 官方接口），绝不依赖 GD Studio 取链。
 *
 * trackId 规范：key = songmid（稳定），即 qq--<songmid>。
 */

const http = require('http');
const { URL } = require('url');

function getJSON(base, pathname, params = {}, timeout = 12000) {
  const u = new URL(base + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, String(v));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(u, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('QQ 接口返回不是 JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('QQ 接口请求超时')));
    req.end();
  });
}

/** 专辑封面 CDN 直链（QQ 官方图片 CDN，公开格式） */
function albumPicUrl(albumMid, size = 500) {
  if (!albumMid) return '';
  return `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg`;
}

/** QQ 取链失败的可识别错误：前端据此提示"QQ版权受限"并跳过 */
function restrictedError(detail) {
  const e = new Error('QQ版权受限：' + (detail || '该曲目暂无可播放链接'));
  e.code = 'QQ_RESTRICTED';
  return e;
}

class QqProvider {
  /**
   * @param baseUrl   内嵌 QQ 服务地址
   * @param tokenStore { getToken, setToken }  会话 token 的加密存取（由 qq-api.js 提供）
   */
  constructor(baseUrl, tokenStore = {}) {
    this.id = 'qq';
    this.name = 'QQ音乐';
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this._tokenCache = undefined;               // 惰性加载
    this._getToken = tokenStore.getToken || (() => '');
    this._setToken = tokenStore.setToken || (() => {});
  }

  get token() {
    if (this._tokenCache === undefined) this._tokenCache = this._getToken() || '';
    return this._tokenCache;
  }

  isAvailable() { return !!this.baseUrl; }

  /** 接口级统一取用：非 200 code 视为业务失败；自动附带会话 token */
  async api(pathname, params = {}, opt = {}) {
    const u = new URL(this.baseUrl + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, String(v));
    }
    const headers = { 'Accept': 'application/json' };
    if (this.token) headers['x-qq-session'] = this.token;   // 认证调用统一走这个头

    const res = await new Promise((resolve, reject) => {
      const req = http.request(u, { method: 'GET', headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.setTimeout(opt.timeout || 12000, () => req.destroy(new Error('QQ 接口请求超时')));
      req.end();
    });

    let data;
    try { data = JSON.parse(res.body); }
    catch (_) { throw new Error('QQ 接口返回不是 JSON'); }

    // 扫码成功（803）：从 Set-Cookie / 响应体的 cookie 字段捕获会话 token，加密落盘
    if (pathname === '/login/qr/check' && data && data.code === 803) {
      let token = '';
      const setCookie = res.headers['set-cookie'];
      if (Array.isArray(setCookie)) {
        for (const c of setCookie) {
          const m = /qqmusic_session=([^;]+)/.exec(String(c));
          if (m && m[1]) { token = m[1]; break; }
        }
      }
      if (!token && typeof data.cookie === 'string') {
        const m = /qqmusic_session=([^;]+)/.exec(data.cookie);
        if (m && m[1]) token = m[1];
      }
      if (token) {
        this._tokenCache = token;
        this._setToken(token);
      }
    }

    if (data && data.code && data.code !== 200) {
      const err = new Error(data.message || data.error || ('QQ 接口错误 code=' + data.code));
      err.code = data.errorKey || ('QQ_CODE_' + data.code);
      err.retryable = !!data.retryable;
      throw err;
    }
    return data;
  }

  /** 搜索结果 → 统一曲目 */
  mapSong(item) {
    const mid = item.mid || item.songmid;
    const singers = (item.singer || item.singers || []).map(s => s.name).join(' / ') || '未知艺术家';
    const album = item.album || {};
    return {
      id: `qq_${mid}`,
      provider: 'qq',
      sourceId: `qq:${mid}`,
      gid: String(mid),
      songId: item.id,                              // 数字 id（写操作要用，如点喜欢）
      title: item.name || item.songname || item.title || '未知曲目',
      artist: singers,
      album: album.name || album.title || item.albumname || '',
      albumId: album.mid || item.albummid || '',
      picUrl: albumPicUrl(album.mid || item.albummid),
      duration: (item.interval || 0) * 1000,        // QQ 是秒，统一成毫秒
      hasCover: !!album.mid,
      hasLyric: true
    };
  }

  /** POST（QQ 写操作全走 POST + x-qq-session token） */
  async post(pathname, body = {}) {
    const u = new URL(this.baseUrl + pathname);
    const token = this.token;
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(u, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { 'x-qq-session': token } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (_) { reject(new Error('QQ 接口返回不是 JSON')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy(new Error('QQ 接口请求超时')));
      req.end(payload);
    });
  }

  /** 点喜欢 / 取消喜欢（QQ 需要 数字 id + mid） */
  async likeTrack(track, like) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    const songId = Number(track.songId);
    if (!mid || !songId) throw new Error('缺少歌曲信息，无法收藏');
    const data = await this.post('/user/song/like', {
      song: { id: songId, mid, type: 0 },
      liked: !!like
    });
    if (data && data.code && data.code !== 200) {
      throw new Error(data.message || ('收藏失败 code=' + data.code));
    }
    return { ok: true };
  }

  /** 加入自建歌单（tid 必须是自建歌单，系统目录会被官方拒绝） */
  async addToPlaylist(track, playlistId) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    const songId = Number(track.songId);
    const tid = Number(playlistId);
    if (!mid || !songId || !tid) throw new Error('缺少歌曲或歌单信息');
    const data = await this.post('/user/playlist/tracks', {
      tid,
      op: 'add',
      songs: [{ id: songId, type: 0 }]
    });
    if (data && data.code && data.code !== 200) {
      throw new Error(data.message || ('添加失败 code=' + data.code));
    }
    return { ok: true };
  }

  /** 新建自建歌单 */
  async createPlaylist(name) {
    const data = await this.post('/user/playlist/create', { name: String(name || '').slice(0, 40) });
    if (data && data.code && data.code !== 200) {
      throw new Error(data.message || ('创建失败 code=' + data.code));
    }
    const id = data && data.data && (data.data.tid || data.data.id);
    return { ok: true, id: id !== undefined ? String(id) : '' };
  }

  async search(keyword, limit = 30, page = 1) {
    const data = await this.api('/search', { keyword, limit, page });
    const items = (data.items || data.data || []).map(x => this.mapSong(x));
    return items;
  }

  /**
   * 取链：/getMusicPlay/:songmid?quality=N
   * quality: 128 / 320 / flac（由音质档位偏好映射，拿不到自动降档）
   */
  async getStream(track, opts = {}) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    if (!mid) throw new Error('缺少 QQ 歌曲 songmid');

    const QUALITIES = ['flac', '320', '128'];
    const want = String(opts.quality || '320').toLowerCase();
    const startIdx = Math.max(0, QUALITIES.indexOf(want));

    let lastErr = null;
    for (let i = startIdx; i < QUALITIES.length; i++) {
      try {
        const data = await this.api(`/getMusicPlay/${encodeURIComponent(mid)}`, { quality: QUALITIES[i] });
        const info = data && data.data && data.data.playUrl && data.data.playUrl[mid];
        if (info && info.url) {
          return {
            url: info.url,
            level: QUALITIES[i],
            via: 'qq-official',
            downgraded: i !== startIdx
          };
        }
        // 官方明确返回 restriction / error → 风控或版权，不再降档重试
        const restriction = info && info.restriction;
        lastErr = restrictedError(
          (restriction && (restriction.hint && restriction.hint.message || restriction.key)) ||
          (info && info.error) || '空链接'
        );
        break;
      } catch (err) {
        lastErr = err;
        // 网络/超时类错误才降档重试；明确的业务限制直接抛
        if (err.code === 'QQ_RESTRICTED') break;
      }
    }
    throw lastErr || restrictedError();
  }

  async getLyric(track) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    const data = await this.api('/getLyric', { songmid: mid, trans: 1 });
    const r = (data && data.response) || {};
    const lyric = typeof r.lyric === 'string' ? r.lyric
      : (r.lyric && r.lyric.lyric) || '';
    const translated = typeof r.trans === 'string' ? r.trans
      : (r.trans && r.trans.trans) || '';
    return { lrc: lyric, translated, source: 'QQ音乐' };
  }

  async getCover(track) {
    const url = track.picUrl || albumPicUrl(track.albumId, 500);
    if (url) return { redirect: url };
    return null;
  }

  /** 由路由 id + meta 构建曲目（buildTrack 由组合层提供，这里补 QQ 专属字段映射） */
  async status() {
    if (!this.baseUrl) return { ok: false, reason: 'QQ 服务未启动' };
    try {
      const data = await this.api('/login/status');
      const profile = (data && data.data && data.data.profile) || null;
      return {
        ok: true,
        loggedIn: !!profile,
        nickname: (profile && (profile.nickname || profile.nick)) || '',
        userId: (profile && (profile.uin || profile.userId)) || '',
        avatarUrl: (profile && (profile.avatarUrl || profile.avatar)) || ''
      };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * 歌单能力：/user/playlist（自建+收藏）、/user/liked-songs（我喜欢）、
   * /getSongListDetail/:disstid（歌单曲目）。
   * 未登录时这些接口会返回业务错误，由上层转成"登录后可用"。
   */
  get playlists() {
    const self = this;
    return {
      async list() {
        const data = await self.api('/user/playlist');
        // 包的 toUserPlaylistBody：{ code, playlist: [...], total, more }
        // 条目原始字段：dirId(201=我喜欢)/dirName/tid/songNum/bigpicUrl/opType(5=喜欢)
        const arr = (data && (data.playlist || data.list)) || [];
        return arr.map((p, i) => ({
          id: String(p.tid || p.disstid || p.dissid || p.dirId || i),
          name: p.dirName || p.dissname || p.name || '未命名歌单',
          cover: p.bigpicUrl || p.imgurl || p.picurl || p.picUrl || '',
          count: p.songNum || p.song_count || p.songcnt || 0,
          special: (p.dirId === 201 || p.opType === 5) ? 'like' : ''
        }));
      },
      async tracks(pid, { offset = 0, limit = 50 } = {}) {
        // 我喜欢走专用接口，其余走歌单详情
        let songs = [];
        let total = null;
        if (String(pid) === 'liked') {
          const data = await self.api('/user/liked-songs', { offset, limit });
          songs = (data && (data.songs || data.data || [])) || [];
        } else {
          const data = await self.api(`/getSongListDetail/${encodeURIComponent(pid)}`);
          // 原始结构：response.cdlist[0] = { songlist: [...], songnum, dissname, ... }
          const body = (data && data.response && Array.isArray(data.response.cdlist)
            ? data.response.cdlist[0]
            : (data && (data.data || data))) || {};
          songs = body.songlist || body.songs || [];
          total = body.songnum || body.total_song_num || body.total || null;
        }
        const tracks = songs.map(x => self.mapSong(x));
        return {
          tracks,
          total: total !== null ? total : (tracks.length < limit ? offset + tracks.length : null),
          hasMore: tracks.length >= limit
        };
      }
    };
  }

  /** 账号能力声明 */
  get account() {
    const self = this;
    return { async status() { return self.status(); } };
  }

  /** 防御式从任意响应里取第一个歌曲数组 */
  _pickArray(d) {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    for (const k of ['data', 'list', 'songs', 'items', 'songlist']) {
      if (Array.isArray(d[k])) return d[k];
    }
    for (const v of Object.values(d)) {
      if (v && typeof v === 'object') {
        for (const k of ['data', 'list', 'songs', 'items', 'songlist']) {
          if (Array.isArray(v[k])) return v[k];
        }
      }
    }
    return [];
  }

  /** 推荐能力：similar=基于种子相似歌；personalfm=猜你喜欢（登录） */
  get recommend() {
    const self = this;
    return {
      async next(type, cursor = {}) {
        if (type === 'similar') {
          if (!cursor.seedMid) throw new Error('缺少种子歌曲');
          const data = await self.api('/song/similar', { songmid: cursor.seedMid });
          const arr = self._pickArray(data && data.data ? data.data : data);
          return { tracks: arr.map(x => self.mapSong(x)).filter(Boolean), cursor };
        }
        // personalfm：猜你喜欢
        const data = await self.api('/user/guess-you-like');
        const arr = self._pickArray(data);
        return { tracks: arr.map(x => self.mapSong(x)).filter(Boolean), cursor };
      }
    };
  }

  /** 登出：清包内会话仓库中的凭证 + 本地 token */
  async logout() {
    try { await this.api('/logout'); } catch (_) {}
    this._setToken('');
  }
}

module.exports = QqProvider;
