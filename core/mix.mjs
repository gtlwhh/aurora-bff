/**
 * core/mix.mjs · 双平台推荐合并（共享源头：桌面端 server 与移动端 BFF 共用）
 *
 * mergeMixRecommendations({ ne, qq }):
 *   - 网易云与 QQ 的推荐曲目**交替穿插**（一首网易、一首 QQ），避免整段同平台
 *   - 某一侧为空/失败时自然退化为单平台连续（不报错、不卡死）
 *   - 返回 { tracks, sides }，sides = 实际参与的平台（供 UI 提示"双平台混合"）
 */
export function mergeMixRecommendations({ ne = [], qq = [] } = {}) {
  const a = (Array.isArray(ne) ? ne : []).filter(Boolean);
  const b = (Array.isArray(qq) ? qq : []).filter(Boolean);
  const tracks = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length) tracks.push(a[i++]);
    if (j < b.length) tracks.push(b[j++]);
  }
  const sides = [];
  if (a.length) sides.push('netease');
  if (b.length) sides.push('qq');
  return { tracks, sides };
}

/** 平台分布统计（供日志 / UI 提示） */
export function mixSidesOf(tracks) {
  const set = new Set((tracks || []).map(t => t && t.provider).filter(Boolean));
  return [...set];
}
