const ncm = require('../../lib/ncm');
module.exports = async (req, res) => {
  try { await ncm.qrCreate(req, res); }
  catch (err) { res.status(502).json({ error: err.message }); }
};
