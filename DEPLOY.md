# Deploying the Mini App draw

This adds a Telegram Mini App (a small web page opened inside Telegram) that
shows a live countdown and an animated spin for the final draw, replacing
the old GIF-based wheel. Two things are new:

- `webapp/` — an Express server + static page (the Mini App itself)
- `start.js` — runs the bot and the Mini App server together in one process

Because the Mini App is a real web page, it needs to be hosted somewhere
with **HTTPS**. Telegram will not open a Mini App over plain HTTP or a
self-signed cert.

## 1. Register the Mini App with @BotFather

1. Open a chat with **@BotFather**.
2. Send `/newapp`, pick your bot.
3. Give it a title (e.g. "Live Draw") and short description.
4. Upload an icon (640×360 PNG works well — a simple wheel/emoji graphic is fine).
5. When asked for the **Web App URL**, you can paste a placeholder for now
   (e.g. `https://example.com`) — you'll come back and set the real one
   after deploying in step 3.
6. BotFather gives you a **short name** (you chose it, e.g. `draw`). This
   must exactly match `MINIAPP_SHORT_NAME` in your `.env`.

## 2. Deploy the app somewhere with HTTPS

Simplest option if you don't have hosting yet: **Render.com** (free web
service tier, though it sleeps after inactivity — see the note at the
bottom if that matters for you).

1. Push this project to a GitHub repo.
2. On Render: **New → Web Service** → connect the repo.
3. Build command: `npm install`
4. Start command: `npm start` (runs `start.js`, i.e. bot + Mini App together)
5. Add environment variables (Render → your service → Environment):
   - `BOT_TOKEN`
   - `ADMIN_CHAT_ID`
   - `ANNOUNCE_CHAT_ID`
   - `TELEBIRR_NUMBER`, `TELEBIRR_NAME`
   - `LOCK_MINUTES` (optional, defaults to 5)
   - `MINIAPP_SHORT_NAME` (must match what you set in BotFather, e.g. `draw`)
   - `BOT_USERNAME` (optional — the bot fetches this itself at startup if unset)
   - Render sets `PORT` automatically; the app reads it, you don't need to set it.
6. Deploy. Render will give you a URL like `https://your-app.onrender.com`.

Other options that work the same way: Fly.io, Railway, a small VPS behind
Caddy/nginx with Let's Encrypt. The requirement is just: one public HTTPS
URL that serves `webapp/public/` and proxies `/api/*` to the Express app —
which is exactly what `npm start` already does on its own, no separate
reverse proxy needed if your host terminates TLS for you (Render, Railway,
Fly all do).

## 3. Point BotFather at your real URL

1. Back in @BotFather: `/myapps` → select your bot → select the Mini App →
   **Edit Web App URL** → paste `https://your-app.onrender.com/` (the root
   URL — the app serves `index.html` from there).
2. That's it — the direct link the bot posts
   (`https://t.me/<bot_username>/<short_name>?startapp=...`) will now open
   your deployed page.

## 4. Try it end to end

1. Fill a round (or lower `TOTAL_NUMBERS` temporarily in `bot.js` for testing).
2. Once the last number is confirmed, the admin chat gets three buttons:
   **1 min / 5 min / Instant**.
3. Tap one — the channel gets a message with a **🎡 ቀጥታ ማዞሪያውን ይክፈቱ**
   button. Tap it (from a phone with Telegram, not a browser — Mini App
   links only open inside the Telegram app).
4. You should see the countdown (or an immediate spin), then the wheel
   animating to a landing number, then the winner card.

## Notes / caveats

- **Free-tier cold starts**: Render's free web services spin down after
  ~15 minutes idle and take a few seconds to wake on the next request —
  including the bot's own polling loop and the Mini App page load. If that
  matters for your users, a paid "always on" tier (or Fly.io's small VMs)
  avoids it.
- **Single source of truth**: the actual winner is decided once, server-side,
  in `bot.js` — the Mini App only polls and animates. That's intentional:
  it keeps the draw fair even if 50 people have the Mini App open at once,
  and it keeps working (minus the live visual) even for people who never
  open the Mini App, since the plain-text result still posts to the channel.
- **Restart safety**: if the bot process restarts mid-countdown or
  mid-spin, a 30-second sweep (already in `bot.js`) picks the draw back up
  from the persisted `spin_target_time` instead of leaving it stuck.
- You can delete `wheel-render.js` and the `@napi-rs/canvas` / `gifenc`
  dependencies if you had them installed — they're no longer used now that
  the wheel is drawn live in the Mini App instead of pre-rendered as a GIF.
