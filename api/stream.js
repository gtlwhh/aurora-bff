const ncm = require('../lib/ncm');
/** GET /api/stream?id=&level= —— 返回可播放直链（App 原生播放器拉流） */
module.exports = async (req, res) => {
  try { await ncm.playUrl(req, res); }
  catch (err) { res.status(502).json({ error: err.message }); }
};
