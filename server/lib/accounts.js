'use strict';
/**
 * AccountManager · 多平台账号统一管理
 *
 * 职责：
 *   1. 每个平台最多一个活跃会话；可同时登录多个平台（互不影响）。
 *   2. 统一扫码流程：qrStart(platform) → 前端轮询 qrCheck(platform, key) →
 *      扫码成功自动持久化 → 重启恢复。
 *   3. 凭证加密落盘：Electron safeStorage（DPAPI）。服务跑在 Electron 主进程里，
 *      直接可用；纯 node 调试模式下没有 safeStorage，会话只保存在内存并明确标注，
 *      绝不明文写 settings.json / accounts.json。
 *   4. 迁移：首次启动发现 settings.json 里有历史明文 cookie，自动转入加密存储并清掉。
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

/* ---- safeStorage：Electron 主进程内可用 ---- */
let safeStorage = null;
try {
  const electron = require('electron');
  if (electron && electron.safeStorage && typeof electron.safeStorage.encryptString === 'function') {
    safeStorage = electron.safeStorage;
  }
} catch (_) { /* 纯 node 调试模式 */ }

function encryptionAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (_) { return false; }
}

/* ---- 落盘 ---- */
function readStore() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function writeStore(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[accounts] 写入失败:', err.message);
  }
}

class AccountManager {
  constructor() {
    // platform -> { cookie, user }（内存中的解密态）
    this._active = new Map();
    // platform -> { qrStart, qrCheck } 平台后端注册表
    this._backends = new Map();
    // platform -> 扫码会话状态 { key, code, message, user, saved, ok, timer, startedAt }
    this._sessions = new Map();
    // 持久化是否被禁用（无 safeStorage）
    this._persistDisabled = !encryptionAvailable();
    if (this._persistDisabled) {
      console.warn('[accounts] safeStorage 不可用（非 Electron 环境），登录态仅保存在内存');
    }
  }

  /** 启动恢复 + 明文迁移。settingsRef = { get(), write(patch) } */
  init(settingsRef) {
    const persisted = readStore();
    for (const [platform, rec] of Object.entries(persisted)) {
      try {
        if (!this._persistDisabled && rec.enc) {
          const cookie = safeStorage.decryptString(Buffer.from(rec.enc, 'base64'));
          this._active.set(platform, { cookie, user: rec.user || null, savedAt: rec.savedAt });
          console.log(`[accounts] ${platform} 登录态已恢复: ${rec.user && rec.user.nickname || ''}`);
        }
      } catch (err) {
        console.warn(`[accounts] ${platform} 登录态解密失败，需要重新登录:`, err.message);
      }
    }

    // 历史明文 cookie 迁移：settings.json → 加密存储
    const legacy = settingsRef.get().neteaseCookie;
    if (legacy && !this._active.has('netease')) {
      this.save('netease', legacy, null);
      settingsRef.write({ neteaseCookie: '' });
      console.log('[accounts] 已迁移 settings.json 中的明文 cookie 到加密存储');
    }
  }

  /** 注册平台登录后端：qrStart() → { key, qrimg }；qrCheck(key) → { code, cookie?, user? } */
  registerBackend(platform, backend) {
    this._backends.set(platform, backend);
  }

  hasBackend(platform) {
    return this._backends.has(platform);
  }

  /* ---------------- 活跃会话 ---------------- */

  getActive(platform) {
    return this._active.get(platform) || null;
  }

  save(platform, secret, user) {
    const rec = { user: user || (this._active.get(platform) || {}).user || null, savedAt: Date.now() };
    if (this._persistDisabled) {
      this._active.set(platform, { cookie: secret, user: rec.user, savedAt: rec.savedAt, volatile: true });
      return { persisted: false };
    }
    const enc = safeStorage.encryptString(secret).toString('base64');
    const all = readStore();
    all[platform] = { ...rec, enc };
    writeStore(all);
    this._active.set(platform, { cookie: secret, user: rec.user, savedAt: rec.savedAt });
    return { persisted: true };
  }

  clear(platform) {
    this._active.delete(platform);
    const all = readStore();
    if (all[platform]) { delete all[platform]; writeStore(all); }
    const session = this._sessions.get(platform);
    if (session && session.timer) clearInterval(session.timer);
    this._sessions.delete(platform);
  }

  /* ---------------- 扫码登录 ---------------- */

  /**
   * 发起扫码。返回 { key, qrimg }；同平台重复发起会取消上一个轮询（单会话原则）。
   */
  async startLogin(platform) {
    const backend = this._backends.get(platform);
    if (!backend) throw new Error(`${platform} 登录尚未接入`);

    const prev = this._sessions.get(platform);
    if (prev && prev.timer) clearInterval(prev.timer);

    const qr = await backend.qrStart();
    const session = {
      key: qr.key,
      qrimg: qr.qrimg || '',
      code: 801,
      message: '等待扫码',
      user: null,
      saved: false,
      ok: null,
      startedAt: Date.now(),
      timer: null
    };
    this._sessions.set(platform, session);

    const tick = async () => {
      const s = this._sessions.get(platform);
      if (!s || s.key !== qr.key) return;

      if (Date.now() - s.startedAt > 10 * 60 * 1000) {
        s.code = 800;
        s.message = '二维码已超时';
        clearInterval(s.timer);
        return;
      }

      try {
        const r = await backend.qrCheck(qr.key);
        s.code = Number(r.code);
        s.message = r.message || s.message;

        if (s.code === 803) {
          // 平台自管凭证（如 QQ：会话存在包内加密仓库，不经这里）
          if (r.handled) {
            s.saved = true;
            s.user = r.user || null;
            s.ok = true;
            console.log(`[accounts] ${platform} 扫码登录成功（凭证由平台会话仓库加密保存）`);
            clearInterval(s.timer);
            return;
          }
          if (!r.cookie) {
            s.message = '扫码成功但没拿到登录凭证，请刷新重试';
            s.ok = false;
            clearInterval(s.timer);
            return;
          }
          const saveRes = this.save(platform, r.cookie, r.user || null);
          s.saved = saveRes.persisted;
          s.user = r.user || null;
          s.ok = true;
          console.log(`[accounts] ${platform} 扫码登录成功（${saveRes.persisted ? '已加密落盘' : '仅内存'}）`);
          clearInterval(s.timer);
        } else if (s.code === 800) {
          clearInterval(s.timer);
        }
      } catch (_) {
        // 网络抖动不打断轮询
      }
    };

    await tick();
    session.timer = setInterval(tick, 2000);
    return { key: session.key, qrimg: session.qrimg };
  }

  /** 前端轮询：读内部会话状态，不打平台接口 */
  checkLogin(platform, key) {
    const s = this._sessions.get(platform);
    if (!s) return { code: 800, message: '登录会话已结束，请刷新二维码' };
    if (key && s.key !== key) return { code: 800, message: '二维码已更新，请使用最新二维码' };

    const out = { code: s.code, message: s.message, ok: s.ok };
    if (s.code === 803) {
      out.user = s.user;
      out.saved = s.saved;
      out.ok = s.ok === true && s.saved !== undefined ? s.saved : s.ok;
      if (this._persistDisabled) out.message = '登录成功（开发模式：凭证仅保存在内存）';
    }
    return out;
  }

  /** 供 /api/settings 等展示（不含敏感信息） */
  describe(platform) {
    const active = this._active.get(platform);
    return {
      supported: this.hasBackend(platform),
      loggedIn: !!active,
      user: active ? active.user : null,
      persisted: active ? !active.volatile : false,
      encryption: encryptionAvailable()
    };
  }
}

module.exports = { AccountManager, encryptionAvailable };
