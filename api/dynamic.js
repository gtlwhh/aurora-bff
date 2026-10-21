/**
 * GET/POST /api/dynamic/next —— 移动端动态推荐（双平台混合）
 *
 * 与桌面端 server/index.js buildMixAdapter 同一套契约：
 *   - 并发请求网易云推荐 + QQ 推荐（QQ 未登录/接口失败 → allSettled 单侧降级，绝不报错）
 *   - 合并统一走 core/mix.mjs（交替穿插），与桌面端行为完全一致
 *   - 返回 { tracks, cursor, sides }，sides = 实际出歌平台（UI 据此提示"双平台混合"）
 *
 * 阶段三接线状态：网易云已通（lib/ncm.js）；QQ 侧待 qq-music-api 的 serverless 适配，
 * 当前 QQ 恒空数组 → core 合并自然退化为纯网易云，不报错。
 */
const ncm = require('../lib/ncm');

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const type = q.type || 'fmix';           // fmix 私人漫游 | heartmix 心动模式
    const limit = Math.min(20, Number(q.limit || 6));

    // ---- 网易云侧（真实） ----
    let neTracks = [];
    try {
      if (type === 'heartmix' && q.seed) {
        // 心动模式：基于种子（/playmode/intelligence/list 需要 cookie）
        const r = await ncm.call('playmode_intelligence_list', { id: q.seed, pid: q.pid || q.seed }, req);
        const arr = (r.data || []).slice(0, limit);
        neTracks = arr.map(x => x && x.songInfo).filter(Boolean).map(ncm.mapSong);
      } else {
        // 私人漫游：官方 FM
        const r = await ncm.call('personal_fm', {}, req);
        neTracks = (r.data || []).map(ncm.mapSong).filter(Boolean);
      }
    } catch (err) {
      console.warn('[bff-dynamic] 网易云侧失败（继续 QQ 侧）:', err.message);
    }

    // ---- QQ 侧（serverless 适配接入后填充；失败/未登录 → 空数组降级） ----
    let qqTracks = [];
    try {
      // TODO 阶段三：接 QQ 猜你喜欢/相似歌（需 x-qq-session 头透传）
      qqTracks = [];
    } catch (err) {
      console.warn('[bff-dynamic] QQ 侧失败（继续网易云侧）:', err.message);
    }

    // ---- 共享合并（与桌面端同一份实现） ----
    let merge;
    try {
      merge = await import('../core/mix.mjs');
    } catch (_) {
      try { merge = await import('./core/mix.mjs'); }
      catch (_2) { merge = { mergeMixRecommendations: ({ ne, qq }) => ({ tracks: [...ne, ...qq], sides: [] }) }; }
    }
    const { tracks, sides } = merge.mergeMixRecommendations({ ne: neTracks, qq: qqTracks });
    res.status(200).json({
      tracks, sides,
      cursor: { seed: q.seed || null, pid: q.pid || null },
      exhausted: tracks.length === 0
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
