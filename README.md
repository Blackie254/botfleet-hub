# BotFleet

Node/Express + Postgres. Wallet top-ups via Paystack, one-click Heroku deploys, monthly KSh 50 renewals with email reminders.

## Deploy BotFleet itself to Heroku
1. `heroku create your-botfleet` then `heroku addons:create heroku-postgresql:essential-0`
2. Set config vars (see `.env.example`): `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, `HEROKU_API_KEY`, `APP_URL`, `SMTP_*`, `MAIL_FROM`, `NODE_ENV=production`
3. `git push heroku main`
4. Paystack dashboard > Settings > API Keys & Webhooks: set the webhook URL to `https://YOUR_DOMAIN/api/paystack/webhook`
5. Paystack dashboard: enable M-Pesa / mobile money, card and bank for KES

## Local
`npm i && cp .env.example .env` (fill it in) then `npm start`

## Customising bots
Edit the `BOTS` array in `server.js` (repo, branch, `sessionVar`, `process`, `pairUrl`). All 10 slots currently point to BLACK MD BOT.

## Billing rules
Deploy debits KSh 50 atomically from the wallet; a failed deploy auto-refunds. Hourly job: reminders at 3 days and 1 day (only if wallet < KSh 50), auto-renews from wallet at expiry, otherwise stops the dyno and emails; suspended bots are deleted after 7 days.
