// Runs the Telegram bot (long polling) and the Mini App web server in one
// process, so a single "web service" deploy (Render, Fly.io, a VPS, etc.)
// covers both. This project keeps all files flat in the repo root rather
// than in a webapp/ subfolder, so both requires are local paths.
require('./bot');
require('./server');
