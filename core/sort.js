/**
 * core/sort.js · 聚合搜索排序（双端共享，与桌面端一致的四档强制权重）
 */

function relevanceScore(t, q) {
  const title = (t.title || '').toLowerCase();
  const artist = (t.artist || '').toLowerCase();
  const ql = q.toLowerCase().trim();
  const all = title + ' ' + artist;
  let s = 0;
  if (title === ql) s += 12;
  else if (title.startsWith(ql)) s += 7;
  else if (title.includes(ql)) s += 4;
  if (artist.includes(ql)) s += 3;
  const parts = ql.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every(p => all.includes(p))) s += 5;
  return s;
}

/**
 * 混合列表排序（核心规则）：
 *   强制权重：① 歌手完全匹配(原唱) ② 歌名完全匹配 ③ 歌手含关键词 ④ 其它 ⑤ 伴奏/翻唱/Live 永远垫底
 */
function mixedSortCompare(a, b, q) {
  const d = rankOf(a, q) - rankOf(b, q);
  if (d !== 0) return d;
  const rel = relevanceScore(b, q) - relevanceScore(a, q);   // 同档内相关度
  if (rel !== 0) return rel;
  return String(a.artist || '').localeCompare(String(b.artist || ''), 'zh-Hans-CN');
}

function rankOf(t, q) {
  const penal = /伴奏|instrumental|karaoke|cover|翻唱|remix|live|铃声|dj版/i;
  const title = String(t.title || '').toLowerCase().trim();
  const artist = String(t.artist || '').toLowerCase().trim();
  const ql = q.toLowerCase().trim();
  const parts = ql.split(/\s+/).filter(Boolean);
  const titleQ = parts[0] || ql;                 // 第一个词当歌名关键词
  const artistQ = parts.slice(1).join(' ');      // 其余词当歌手关键词
  // 伴奏 / 翻唱 / Live：永远垫底
  if (penal.test(title)) return 5;
  // ① 歌手名完全匹配（且非伴奏翻唱 = 视为原唱候选）
  if (artistQ && artist === artistQ) return 1;
  // ② 歌名完全匹配
  if (title === titleQ || title === ql) return 2;
  // ③ 歌手名包含关键词
  if (artistQ && artist.includes(artistQ)) return 3;
  // ④ 其它（歌名部分匹配等）
  return 4;
}


export { relevanceScore, mixedSortCompare, rankOf };
