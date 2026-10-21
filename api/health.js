/** BFF 探活：GET /api/health */
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ ok: true, service: 'aurora-bff', time: Date.now() });
};
