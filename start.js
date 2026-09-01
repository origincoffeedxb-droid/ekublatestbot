// Runs the Telegram bot (long polling) and the Mini App web server in one
// process, so a single "web service" deploy (Render, Fly.io, a VPS, etc.)
// covers both. If you'd rather scale them separately later, just deploy
// bot.js and webapp/server.js as two services instead of requiring this file.
require('./bot');
require('./webapp/server');
