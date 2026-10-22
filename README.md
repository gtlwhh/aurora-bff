# 极光音乐 · 服务端（BFF）

网易云 + QQ 音乐双平台的 Node 服务端。桌面端「极光音乐」内置的就是这份代码；
手机端（Capacitor）通过 `http://<服务器IP>:3000` 直连它。

> ⚠️ 本仓库已整体覆盖早期精简版 BFF（旧 `api/`、`lib/ncm.js`、`dev-server.js`、
> `vercel.json`、`netlify/`、`cf-worker/` 均已删除）。

---

## 凭证策略（重要）

**服务端不保存任何账号 Cookie / Token。**

- 手机端扫码成功后，服务端只在响应里把凭证回传一次，客户端存进手机本地（IndexedDB）。
- 之后每个请求都在 header 里带上凭证，服务端仅在本请求内使用：
  - 网易云：`x-ncm-cookie`
  - QQ 音乐：`x-qq-session`
  - `x-client-cred: 1` 表示"本次登录不要落盘"
- 因此服务端重启不会丢登录态（凭证在手机上），多人共用一台服务端也互不串号。

桌面端（Electron）仍走本地加密存储，不受影响。

---

## 功能

| 模块 | 接口 |
|---|---|
| 健康检查 | `GET /api/health` |
| 双平台搜索 | `GET /api/search?q=&provider=netease\|qq&limit=` |
| 音频流 | `GET /api/stream/:provider/:key?meta=` |
| 封面 | `GET /api/cover/:provider/:key?meta=` |
| 歌词 | `GET /api/lyric/:provider/:key?meta=` |
| 账号状态 | `GET /api/account/:platform/status` |
| 扫码登录 | `GET /api/account/:platform/login/qr` |
| 扫码轮询 | `GET /api/account/:platform/login/check?key=` |
| 退出登录 | `POST /api/account/:platform/logout` |
| 歌单 | `GET /api/playlists?platform=`、`GET /api/playlist/tracks?...` |
| 心动/漫游 | `POST /api/dynamic/session`（platform=mix）、`GET /api/dynamic/next` |

`/` 会直接返回桌面端播放器页面（`web/`），可用浏览器打开做连通性检查。

---

## 部署

```bash
git clone https://github.com/gtlwhh/aurora-bff.git
cd aurora-bff
npm config set registry https://registry.npmmirror.com
npm ci --omit=dev || npm install --omit=dev

npm i -g pm2
HOST=0.0.0.0 PORT=3000 pm2 start server/index.js --name aurora --update-env
pm2 save && pm2 startup

curl -s http://127.0.0.1:3000/api/health
```

更新：`git pull && npm ci --omit=dev && pm2 restart aurora`

阿里云安全组记得放行端口。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7788` | 监听端口 |
| `HOST` | `127.0.0.1` | **线上必须 `0.0.0.0`** |
| `AURORA_DATA_DIR` | `./data` | 设置/缓存目录（不含账号凭证） |
