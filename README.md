---
title: Aurora BFF
emoji: 🎵
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# 极光音乐 BFF

网易云音乐真实接口代理（搜索/歌词/取链/歌单/扫码登录/双平台混合推荐）。
桌面端与移动端共用；App 通过 CapacitorHttp 直连本服务。

- `GET /api/health` 探活
- `GET /api/search?q=&limit=` 真实搜索（网易云）
- `GET /api/lyric?id=` 歌词 · `GET /api/stream?id=` 播放直链
- `GET /api/dynamic/next?type=fmix|heartmix` 动态推荐（core/mix.mjs 交替穿插合并）
- `GET /api/login/qr-create` + `/api/login/qr-check?key=` 扫码登录（cookie 由客户端保管透传）
