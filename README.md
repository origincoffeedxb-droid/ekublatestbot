# Number Draw Bot — Setup Guide (no coding required)

This bot runs three tiers (200 / 500 / 1000 ETB). Users pick a free number 1–100,
get 5 minutes to pay via Telebirr and send their transaction ID, an admin approves it,
and once all 100 numbers in a tier are confirmed, a winner is drawn automatically.

## ⚠️ Before you launch

Running a paid numbers draw is a form of gambling/lottery. Please confirm you have
whatever license or registration Ethiopian regulators require (this typically falls
under the National Lottery Administration or relevant gaming authority) before taking
real money from users. This guide only covers the technical setup.

---

## Step 1 — Create your bot on Telegram (5 minutes)

1. Open Telegram, search for **@BotFather**, start a chat.
2. Send `/newbot`, give it a name and a username (must end in "bot").
3. BotFather gives you a **token** like `123456789:AAExample...` — copy it, you'll need it.

## Step 2 — Create your admin group

1. Create a **private** Telegram group, add your bot and your admin staff to it.
2. Send any message in the group.
3. In your browser, go to:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   (replace `<YOUR_TOKEN>` with your real token)
4. Find `"chat":{"id": -100xxxxxxxxxx` in the result — that number is your `ADMIN_CHAT_ID`.

## Step 3 — (Optional) Create a public announcement channel

If you want winners posted publicly, create a Telegram channel, add the bot as admin,
and use its `@username` as `ANNOUNCE_CHAT_ID`.

## Step 4 — Put your details into the config

Open `.env.example`, fill in your real values, and save it as a new file named `.env`:

```
BOT_TOKEN=your token from Step 1
ADMIN_CHAT_ID=your id from Step 2
ANNOUNCE_CHAT_ID=@YourChannel (optional)
TELEBIRR_NUMBER=0912345678
TELEBIRR_NAME=Your Company Name
LOCK_MINUTES=5
```

## Step 5 — Host it (simplest option: Railway.app)

You don't need to touch any code — just upload this folder and click deploy.

1. Go to **https://railway.app** and sign up (free to start).
2. Click **New Project → Deploy from GitHub repo**.
   - Easiest path: create a free GitHub account, create a new repository, upload this
     entire folder to it (GitHub's website lets you drag-and-drop files — no git
     commands needed), then pick that repo in Railway.
3. Once deployed, go to your project's **Variables** tab and paste in the same values
   from your `.env` file (BOT_TOKEN, ADMIN_CHAT_ID, etc.) — one per row.
4. Railway will automatically run `npm install` and `npm start` for you. That's it —
   your bot is now live 24/7. No servers, no domains, no webhook setup needed (the bot
   uses simple "polling" mode, so it just needs to stay running).
5. Whenever you want to change a setting (like your Telebirr number), edit it in the
   Variables tab and Railway restarts the bot automatically.

*(Render.com and Fly.io work the same way if you prefer — "New Web Service" or
"New App" from a repo, add the same environment variables, deploy.)*

## Step 6 — Test it

1. Open your bot in Telegram, send `/start`.
2. Pick a tier, pick a number — confirm it locks and shows the payment instructions.
3. Send any test text as a "transaction ID" — check it shows up with Approve/Reject
   buttons in your admin group.
4. Click Approve — confirm you get a confirmation message back.

## Everyday admin use

- **Approve/Reject**: happens automatically via buttons in your admin group whenever
  someone submits a transaction ID. Always double check the transaction ID against
  your real Telebirr statement before approving — this is the one manual trust step
  in the whole system.
- **See who's confirmed**: `/numbers` in the bot shows the live grid (🔴 = confirmed,
  🟡 = awaiting review, 🔒 = reserved, plain number = open).
- **Force a fresh round** (e.g. to reset a stalled tier): send `/newround a`,
  `/newround b`, or `/newround c` in the admin group (a=200, b=500, c=1000 ETB).
- **Winner announcements** happen automatically the moment a tier's 100th number is
  confirmed — no action needed from you.

## Adding your logo

Send your logo image to @BotFather via `/setuserpic` (for the bot's profile picture)
whenever you're ready to send it over — I can also add it to the welcome message as
an image if you'd like a richer `/start` screen.

## File overview

- `bot.js` — all bot behavior (menus, locking, payments, admin approval, draws)
- `db.js` — local database (SQLite file, created automatically, no setup needed)
- `.env.example` — copy to `.env` and fill in your real values
- `data.sqlite` — created automatically once the bot runs; this is your live data
