require('dotenv').config();
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const crypto = require('crypto'), nodemailer = require('nodemailer'), { Pool } = require('pg');

const E = process.env;
for (const k of ['DATABASE_URL', 'JWT_SECRET', 'PAYSTACK_SECRET_KEY', 'HEROKU_API_KEY', 'APP_URL'])
  if (!E[k]) { console.error('Missing env var: ' + k); process.exit(1); }
const PRICE = +E.BOT_PRICE_KES || 50, MAX_BOTS = +E.MAX_BOTS_PER_USER || 10, TEAM = E.HEROKU_TEAM;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Bot catalog: 10 slots, all BLACK MD for now ---------- */
const BASE = {
  slug: 'blackmd', name: 'BLACK MD BOT',
  tagline: 'Multi-device WhatsApp bot. Pair, paste your Session ID, go live.',
  repo: 'Blackie254/black-super-bot', branch: 'main',
  sessionVar: 'SESSION_ID',   // config var the bot reads its session from
  process: 'worker',          // process type in the bot's Procfile (worker or web)
  pairUrl: 'https://blackmd-pairing.onrender.com',
  env: {},                    // extra config vars to set on every deploy
};
const BOTS = Array.from({ length: 10 }, (_, i) => ({ ...BASE, id: 'bot-' + String(i + 1).padStart(2, '0'), slot: i + 1 }));
// To swap in another bot later: BOTS[3] = { ...BASE, id: 'bot-04', slot: 4, slug: 'other', name: 'OTHER BOT', repo: 'owner/repo', pairUrl: '...' };

/* ---------- DB ---------- */
const pool = new Pool({ connectionString: E.DATABASE_URL, ssl: E.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
const q = (t, p) => pool.query(t, p);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL,
  balance INT NOT NULL DEFAULT 0 CHECK(balance>=0), created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS topups(id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), reference TEXT UNIQUE NOT NULL,
  amount INT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS deployments(id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), bot_id TEXT NOT NULL,
  app_name TEXT UNIQUE NOT NULL, status TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, reminded INT NOT NULL DEFAULT 0,
  suspended_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());`;

/* ---------- Email ---------- */
const mailer = E.SMTP_HOST ? nodemailer.createTransport({ host: E.SMTP_HOST, port: +E.SMTP_PORT || 587, secure: +E.SMTP_PORT === 465, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } }) : null;
const mail = (to, subject, body) => {
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;background:#0b0d1a;color:#e8ecff;border-radius:12px">
  <h2 style="color:#00f0ff;margin:0 0 12px">BOTFLEET</h2>${body}
  <p style="margin-top:20px"><a href="${E.APP_URL}" style="background:#00f0ff;color:#000;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open dashboard</a></p></div>`;
  if (!mailer) return console.log('[mail skipped - no SMTP]', to, subject);
  return mailer.sendMail({ from: E.MAIL_FROM || E.SMTP_USER, to, subject, html }).catch(e => console.error('mail error:', e.message));
};

/* ---------- Heroku Platform API ---------- */
const H = async (method, path, body) => {
  const r = await fetch('https://api.heroku.com' + path, {
    method, headers: { Accept: 'application/vnd.heroku+json; version=3', Authorization: 'Bearer ' + E.HEROKU_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`Heroku ${r.status}: ${j && j.message || t}`);
  return j;
};
const botOf = id => BOTS.find(b => b.id === id) || BASE;
const spend = async uid => (await q('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1 RETURNING balance', [PRICE, uid])).rowCount > 0;

async function failDeployment(id, reason) {
  const { rows } = await q("UPDATE deployments SET status='failed' WHERE id=$1 AND status='deploying' RETURNING user_id,app_name", [id]);
  if (!rows[0]) return;
  console.error('Deploy failed #' + id, reason || '');
  await q('UPDATE users SET balance=balance+$1 WHERE id=$2', [PRICE, rows[0].user_id]);   // automatic refund
  H('DELETE', '/apps/' + rows[0].app_name).catch(() => {});
}
async function provision(d, bot, session) {
  try {
    await H('POST', TEAM ? '/teams/apps' : '/apps', { name: d.app_name, region: E.HEROKU_REGION || 'eu', ...(TEAM && { team: TEAM }) });
    await H('PATCH', `/apps/${d.app_name}/config-vars`, { [bot.sessionVar]: session, ...bot.env });  // session lives only on Heroku
    const b = await H('POST', `/apps/${d.app_name}/builds`, { source_blob: { url: `https://github.com/${bot.repo}/tarball/${bot.branch}` } });
    for (let i = 0; ; i++) {
      await sleep(5000);
      const s = await H('GET', `/apps/${d.app_name}/builds/${b.id}`);
      if (s.status === 'succeeded') break;
      if (s.status === 'failed') throw new Error('Build failed');
      if (i > 120) throw new Error('Build timed out');
    }
    await H('PATCH', `/apps/${d.app_name}/formation/${bot.process}`, { quantity: 1 });
    await q("UPDATE deployments SET status='running' WHERE id=$1 AND status='deploying'", [d.id]);
  } catch (e) { await failDeployment(d.id, e.message); }
}

/* ---------- Paystack ---------- */
const PS = (p, o = {}) => fetch('https://api.paystack.co' + p, { ...o, headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' } }).then(r => r.json());
async function credit(ref, paidMinor) {   // idempotent: only the first success credits
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query("UPDATE topups SET status='success' WHERE reference=$1 AND status='pending' AND amount*100<=$2 RETURNING user_id,amount", [ref, paidMinor]);
    if (rows[0]) await c.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [rows[0].amount, rows[0].user_id]);
    await c.query('COMMIT'); return !!rows[0];
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': null } } }));
app.use(express.json({ limit: '50kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(express.static('public'));

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const auth = async (req, res, next) => {
  try {
    const { uid } = jwt.verify(req.cookies.bf, E.JWT_SECRET);
    const { rows } = await q('SELECT id,email,name,balance FROM users WHERE id=$1', [uid]);
    if (!rows[0]) throw 0; req.user = rows[0]; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
};
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const setCookie = (res, uid) => res.cookie('bf', jwt.sign({ uid }, E.JWT_SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', secure: E.NODE_ENV === 'production', maxAge: 30 * 864e5 });

app.get('/api/bots', (_req, res) => res.json({ price: PRICE, bots: BOTS.map(({ id, slot, name, tagline, pairUrl }) => ({ id, slot, name, tagline, pairUrl })) }));

app.post('/api/signup', authLimit, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60), email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) return res.status(400).json({ error: 'Enter your name, a valid email and a password of 8+ characters' });
  try {
    const { rows } = await q('INSERT INTO users(email,name,pass_hash) VALUES($1,$2,$3) RETURNING id', [email, name, await bcrypt.hash(pw, 11)]);
    setCookie(res, rows[0].id); res.json({ ok: true });
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'That email is already registered' : 'Server error' }); }
}));
app.post('/api/login', authLimit, wrap(async (req, res) => {
  const { rows } = await q('SELECT id,pass_hash FROM users WHERE email=$1', [String(req.body.email || '').trim().toLowerCase()]);
  if (!rows[0] || !(await bcrypt.compare(String(req.body.password || ''), rows[0].pass_hash))) return res.status(401).json({ error: 'Wrong email or password' });
  setCookie(res, rows[0].id); res.json({ ok: true });
}));
app.post('/api/logout', (_req, res) => res.clearCookie('bf').json({ ok: true }));
app.get('/api/me', auth, (req, res) => res.json({ user: req.user, price: PRICE }));

app.post('/api/topup', auth, wrap(async (req, res) => {
  const amount = Math.floor(+req.body.amount);
  if (!(amount >= PRICE && amount <= 50000)) return res.status(400).json({ error: `Amount must be between KSh ${PRICE} and KSh 50,000` });
  const ref = 'bf_' + crypto.randomBytes(10).toString('hex');
  await q('INSERT INTO topups(user_id,reference,amount) VALUES($1,$2,$3)', [req.user.id, ref, amount]);
  const r = await PS('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email: req.user.email, amount: amount * 100, currency: 'KES', reference: ref, callback_url: E.APP_URL + '/api/paystack/callback' }) });
  if (!r.status) return res.status(502).json({ error: 'Payment could not be started: ' + (r.message || 'unknown') });
  res.json({ url: r.data.authorization_url });
}));
app.get('/api/paystack/callback', async (req, res) => {   // user returns here after paying
  try {
    const ref = String(req.query.reference || req.query.trxref || '');
    const r = await PS('/transaction/verify/' + encodeURIComponent(ref));
    if (r.status && r.data.status === 'success' && r.data.currency === 'KES') await credit(ref, r.data.amount);
    res.redirect('/?paid=1');
  } catch (e) { console.error(e); res.redirect('/?paid=0'); }
});
app.post('/api/paystack/webhook', wrap(async (req, res) => {   // backup: credits even if the user closes the tab
  const sig = crypto.createHmac('sha512', E.PAYSTACK_SECRET_KEY).update(req.rawBody || '').digest('hex');
  if (sig !== req.headers['x-paystack-signature']) return res.sendStatus(401);
  const { event, data } = req.body;
  if (event === 'charge.success' && data.currency === 'KES') await credit(data.reference, data.amount);
  res.sendStatus(200);
}));

app.get('/api/deployments', auth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id,bot_id,app_name,status,expires_at FROM deployments WHERE user_id=$1 AND status<>'deleted' AND status<>'failed' ORDER BY id DESC", [req.user.id]);
  res.json({ deployments: rows.map(d => ({ ...d, bot: botOf(d.bot_id).name })) });
}));
app.post('/api/deploy', auth, wrap(async (req, res) => {
  const bot = BOTS.find(b => b.id === req.body.botId), session = String(req.body.sessionId || '').trim();
  if (!bot) return res.status(400).json({ error: 'Unknown bot' });
  if (session.length < 8 || session.length > 20000) return res.status(400).json({ error: 'Paste a valid Session ID' });
  const n = +(await q("SELECT count(*) FROM deployments WHERE user_id=$1 AND status IN ('deploying','running','suspended')", [req.user.id])).rows[0].count;
  if (n >= MAX_BOTS) return res.status(400).json({ error: `Limit of ${MAX_BOTS} bots reached` });
  if (!(await spend(req.user.id))) return res.status(402).json({ error: `Insufficient balance. Top up at least KSh ${PRICE}.` });
  const name = `bf-${bot.slug}-${crypto.randomBytes(4).toString('hex')}`.slice(0, 30);
  const { rows } = await q("INSERT INTO deployments(user_id,bot_id,app_name,status,expires_at) VALUES($1,$2,$3,'deploying',now()+interval '30 days') RETURNING *", [req.user.id, bot.id, name]);
  res.json({ ok: true }); provision(rows[0], bot, session);
}));
app.post('/api/deployments/:id/renew', auth, wrap(async (req, res) => {
  const { rows } = await q("SELECT * FROM deployments WHERE id=$1 AND user_id=$2 AND status IN ('running','suspended')", [req.params.id, req.user.id]);
  const d = rows[0]; if (!d) return res.status(404).json({ error: 'Not found' });
  if (!(await spend(req.user.id))) return res.status(402).json({ error: `Insufficient balance. Top up at least KSh ${PRICE}.` });
  try {
    if (d.status === 'suspended') await H('PATCH', `/apps/${d.app_name}/formation/${botOf(d.bot_id).process}`, { quantity: 1 });
  } catch (e) { await q('UPDATE users SET balance=balance+$1 WHERE id=$2', [PRICE, req.user.id]); return res.status(502).json({ error: 'Could not restart the bot, you were not charged' }); }
  await q("UPDATE deployments SET status='running', reminded=0, suspended_at=NULL, expires_at=(CASE WHEN status='running' AND expires_at>now() THEN expires_at ELSE now() END)+interval '30 days' WHERE id=$1", [d.id]);
  res.json({ ok: true });
}));
app.delete('/api/deployments/:id', auth, wrap(async (req, res) => {
  const { rows } = await q("UPDATE deployments SET status='deleted' WHERE id=$1 AND user_id=$2 AND status IN ('running','suspended') RETURNING app_name", [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  H('DELETE', '/apps/' + rows[0].app_name).catch(() => {}); res.json({ ok: true });
}));

/* ---------- Billing cron (hourly): reminders, auto-renew, suspend, cleanup ---------- */
async function tick() {
  const stale = await q("SELECT id FROM deployments WHERE status='deploying' AND created_at<now()-interval '30 minutes'");
  for (const s of stale.rows) await failDeployment(s.id, 'stuck');
  const { rows } = await q("SELECT d.*,u.email,u.name,u.balance FROM deployments d JOIN users u ON u.id=d.user_id WHERE d.status IN ('running','suspended')");
  for (const d of rows) {
    try {
      const bot = botOf(d.bot_id), left = (new Date(d.expires_at) - Date.now()) / 864e5;
      if (d.status === 'suspended') {
        if ((Date.now() - new Date(d.suspended_at)) / 864e5 >= 7) {
          await q("UPDATE deployments SET status='deleted' WHERE id=$1", [d.id]); await H('DELETE', '/apps/' + d.app_name).catch(() => {});
          mail(d.email, 'Your bot was removed', `<p>Hi ${d.name}, your <b>${bot.name}</b> stayed suspended for 7 days and has been deleted. You can deploy a fresh one anytime.</p>`);
        }
      } else if (left <= 0) {
        if (await spend(d.user_id)) {
          await q("UPDATE deployments SET expires_at=expires_at+interval '30 days', reminded=0 WHERE id=$1", [d.id]);
          mail(d.email, 'Bot renewed', `<p>Hi ${d.name}, your <b>${bot.name}</b> was renewed for 30 days (KSh ${PRICE} from your wallet).</p>`);
        } else {
          await H('PATCH', `/apps/${d.app_name}/formation/${bot.process}`, { quantity: 0 });
          await q("UPDATE deployments SET status='suspended', suspended_at=now() WHERE id=$1", [d.id]);
          mail(d.email, 'Your bot has been switched off', `<p>Hi ${d.name}, your <b>${bot.name}</b> was switched off because your wallet had less than KSh ${PRICE}. Top up and hit Renew within 7 days to bring it back, or it will be deleted.</p>`);
        }
      } else {
        const lvl = left <= 1 ? 2 : left <= 3 ? 1 : 0;
        if (lvl > d.reminded && d.balance < PRICE) {
          await q('UPDATE deployments SET reminded=$1 WHERE id=$2', [lvl, d.id]);
          mail(d.email, `Top up now: your bot expires in ${Math.ceil(left)} day(s)`, `<p>Hi ${d.name}, your <b>${bot.name}</b> is due for renewal in ${Math.ceil(left)} day(s). Your wallet has KSh ${d.balance}; you need KSh ${PRICE}. Top up to keep it online. It renews automatically from your wallet.</p>`);
        }
      }
    } catch (e) { console.error('tick error #' + d.id, e.message); }
  }
}

pool.query(SCHEMA).then(() => {
  app.listen(E.PORT || 3000, () => console.log('BotFleet running on :' + (E.PORT || 3000)));
  setTimeout(() => tick().catch(console.error), 15000);
  setInterval(() => tick().catch(console.error), 36e5);
}).catch(e => { console.error('DB init failed', e); process.exit(1); });
