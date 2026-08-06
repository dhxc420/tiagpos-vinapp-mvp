const serverless = require('serverless-http');
const app = require('../backend/index.js');
module.exports = serverless(app);
