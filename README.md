# 极光音乐 · 服务端（BFF）

网易云 + QQ 音乐双平台的 Node 服务端。桌面端「极光音乐」内置的就是这份代码；
手机端（Capacitor）通过 `http://<服务器IP>:3000` 直连它。

> ⚠️ 本仓库已**整体覆盖**早期的精简版 BFF（旧的 `api/`、`lib/ncm.js`、`dev-server.js`、
> `vercel.json`、`netlify/`、`cf-worker/` 均已删除）。旧版只有网易云、没有账号体系，
> 手机端会 404，请勿再使用。

---

## 功能

| 模块 | 接口 | 说明 |
|---|---|---|
| 健康检查 | `GET /api/health` | 探活 |
| 双平台搜索 | `GET /api/search?q=&provider=netease\|qq&limit=` | 两个平台分别请求，客户端合并排序 |
| 音频流 | `GET /api/stream/:provider/:key?meta=` | 服务端代理，QQ 取链在服务器侧完成 |
| 封面 | `GET /api/cover/:provider/:key?meta=` | 带缓存 |
| 歌词 | `GET /api/lyric/:provider/:key?meta=` | LRC |
| 账号状态 | `GET /api/account/:platform/status` | platform = netease / qq |
| 扫码登录 | `GET /api/account/:platform/login/qr` | 返回 `{key, qrimg}` |
| 扫码轮询 | `GET /api/account/:platform/login/check?key=` | 801 等待 / 802 待确认 / 803 成功 / 800 过期 |
| 退出登录 | `POST /api/account/:platform/logout` | |
| 歌单 | `GET /api/playlists?platform=`、`GET /api/playlist/tracks?...` | |
| 心动/漫游 | `POST /api/dynamic/session`、`GET /api/dynamic/next` | 双平台混合 |

另外 `/` 会直接返回桌面端播放器页面（`web/`），可用浏览器打开做连通性/功能检查。

---

## 部署（Ubuntu / CentOS 通用）

```bash
# 1. Node 20（已装可跳过）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs   # Ubuntu
# CentOS: curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs
node -v

# 2. 拉代码
git clone https://github.com/gtlwhh/aurora-bff.git
cd aurora-bff

# 3. 装依赖（跳过 electron 等开发依赖）
npm config set registry https://registry.npmmirror.com
npm ci --omit=dev || npm install --omit=dev

# 4. 启动
HOST=0.0.0.0 PORT=3000 node server/index.js
```

### 用 PM2 常驻

```bash
npm i -g pm2
HOST=0.0.0.0 PORT=3000 pm2 start server/index.js --name aurora --update-env
pm2 save && pm2 startup
```

### 验证

```bash
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"platform":"linux","node":"v20.x.x"}
```

阿里云安全组记得放行 `3000/3000`。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7788` | 监听端口，线上一般用 3000 |
| `HOST` | `127.0.0.1` | **线上必须设 `0.0.0.0`**，否则公网访问不到 |
| `AURORA_DATA_DIR` | `./data` | 设置/歌单/登录凭证存放目录（自动创建） |

---

## 说明

- 登录凭证保存在服务器本地（`data/`），不随仓库提交；换手机不用重新扫码。
- 非 Electron 环境下没有系统密钥链，凭证只存在内存，**重启 PM2 后需要重新扫码**。
- 音频流由服务器中转，注意服务器带宽与流量。
