# 极光音乐 BFF

Backend for Frontend：把桌面端 `server/providers` 的接口转发与 mapSong 映射层搬到云端，
Android App 通过 CapacitorHttp 直连本服务（原生 HTTP 无 CORS 限制）。

## 部署（Vercel 免费额度）
```bash
cd bff
npx vercel deploy --prod
```
部署完成后把分配的域名（如 https://aurora-bff.vercel.app）填进
App「设置 → BFF 接口地址」，CapacitorHttp 即直连该域名。

## 阶段三待办
- api/search.js：接入 NeteaseCloudMusicApi（Vercel Node runtime 可直接 require）与
  qq-music-api 的 serverless 适配，复用桌面端 mapSong / 聚合排序。
- cookie 鉴权：用户扫码后 cookie 存 Vercel KV / Upstash（按设备隔离）。
- /api/stream：网易云直链 302 转发（App 原生播放器拉流）。
