// Vercel's Node runtime invokes functions with (req, res),
// so the Express app can be exported directly as the handler.
const app = require('../backend/index.js');
module.exports = app;
