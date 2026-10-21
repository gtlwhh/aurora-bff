const ncm = require('../lib/ncm');
/** GET /api/playlists?platform=netease&id= 分发 */
module.exports = async (req, res) => {
  try {
    if (req.query.id) return await ncm.playlistTracks(req, res);
    return await ncm.userPlaylists(req, res);
  } catch (err) { res.status(502).json({ error: err.message }); }
};
