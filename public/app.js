const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let me = null, price = 50, bots = [], deps = [], poll = null;

const api = async (p, o = {}) => {
  const r = await fetch('/api' + p, { method: o.method || (o.body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
};
const toast = (m, bad) => { const d = document.createElement('div'); d.textContent = m; if (bad) d.className = 'bad'; $('#toast').append(d); setTimeout(() => d.remove(), 4200); };
const modal = h => { $('#modal').innerHTML = `<div class="box"><button class="x" data-a="close">×</button>${h}</div>`; $('#modal').classList.remove('hidden'); };
const close = () => $('#modal').classList.add('hidden');
const ksh = n => 'KSh ' + Number(n).toLocaleString();
const daysLeft = d => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 864e5));

/* ---------- views ---------- */
function nav() {
  $('#nav').innerHTML = me
    ? `<span class="chip">${esc(me.name)} · ${ksh(me.balance)}</span><button class="btn sm" data-a="logout">Log out</button>`
    : `<button class="btn sm" data-a="auth" data-m="login">Log in</button><button class="btn sm pri" data-a="auth" data-m="signup">Get started</button>`;
}
const botCard = b => `<div class="card"><div class="row"><div class="icon">🤖</div><span class="online"><i class="dot"></i>READY</span></div>
  <div class="slot" style="margin-top:14px">SLOT ${String(b.slot).padStart(2, '0')}</div><h3>${esc(b.name)}</h3><p>${esc(b.tagline)}</p>
  <div class="row"><b>${ksh(price)}<small style="color:var(--mut);font-weight:400"> /mo</small></b><button class="btn sm pri" data-a="deploy" data-id="${b.id}">Deploy</button></div></div>`;

function landing() {
  $('#app').innerHTML = `
  <section class="hero"><span class="eyebrow"><i class="dot"></i>${bots.length} BOT SLOTS ONLINE</span>
    <h1>Deploy WhatsApp bots<br><em>at light speed.</em></h1>
    <p class="lead">Top up with M-Pesa, card or bank. Paste your Session ID. Your bot goes live on its own dedicated server, no code, no terminal.</p>
    <div class="cta"><button class="btn pri big" data-a="auth" data-m="signup">Launch your bot →</button><a class="btn big" href="#bots">Browse bots</a></div>
    <div class="stats"><div><b>${ksh(price)}</b><span>per bot / month</span></div><div><b>M-PESA</b><span>card · bank · mobile money</span></div><div><b>24/7</b><span>dedicated server per bot</span></div></div></section>
  <section id="bots"><h2>Choose your <em style="font-style:normal;color:var(--c1)">bot</em></h2><p class="sub">Every bot runs in its own isolated app.</p><div class="grid">${bots.map(botCard).join('')}</div></section>
  <section class="steps"><h2>How it works</h2><p class="sub">Four steps. A few minutes.</p><div class="grid">
    ${[['Create account', 'Sign up with your email.'], ['Top up wallet', 'Pay via Paystack: M-Pesa, card or bank.'], ['Get Session ID', 'Pair your WhatsApp on the pairing site.'], ['Deploy', 'Paste the ID, hit deploy, done.']].map((s, i) => `<div class="card"><div class="num">0${i + 1}</div><h3>${s[0]}</h3><p>${s[1]}</p></div>`).join('')}</div></section>
  <section><div class="card price"><div class="slot">SIMPLE PRICING</div><div class="amt">${ksh(price)}</div><p>per bot, per month. Renewals come from your wallet, and we email you before anything switches off.</p><button class="btn pri big" data-a="auth" data-m="signup">Create free account</button></div></section>
  <footer>© ${new Date().getFullYear()} BotFleet · Payments secured by Paystack</footer>`;
}

function dash() {
  const afford = Math.floor(me.balance / price);
  $('#app').innerHTML = `<section>
  <div class="card wallet"><div class="slot">WALLET</div><div class="amt">${ksh(me.balance)}</div><p>Covers <b>${afford}</b> bot${afford === 1 ? '' : 's'} for one month.</p>
    <div class="chips">${[50, 100, 250, 500, 1000].map(a => `<button class="btn sm" data-a="topup" data-amt="${a}">+${a}</button>`).join('')}</div>
    <div class="row" style="gap:8px"><input id="amt" type="number" min="${price}" placeholder="Custom amount (KSh)" style="margin:0"><button class="btn pri" data-a="topup">Top up</button></div></div>
  <h2 style="margin-top:44px">My bots</h2><div class="card" style="margin-top:14px">${deps.length ? deps.map(d => `
    <div class="dep"><div><b>${esc(d.bot)}</b><div style="color:var(--mut);font-size:13px">${esc(d.app_name)} · ${d.status === 'deploying' ? 'starting up…' : daysLeft(d.expires_at) + ' days left'}</div></div>
    <div class="row" style="gap:8px"><span class="st ${d.status}">${d.status}</span>${d.status !== 'deploying' ? `<button class="btn sm" data-a="renew" data-id="${d.id}">${d.status === 'suspended' ? 'Restart' : 'Renew +30d'} (${ksh(price)})</button><button class="btn sm red" data-a="del" data-id="${d.id}">Delete</button>` : ''}</div></div>`).join('')
    : '<p style="color:var(--mut)">No bots yet. Deploy your first one below.</p>'}</div>
  <h2 style="margin-top:44px">Deploy a bot</h2><p class="sub">${ksh(price)} is taken from your wallet when you deploy.</p><div class="grid">${bots.map(botCard).join('')}</div></section>`;
  clearInterval(poll);
  if (deps.some(d => d.status === 'deploying')) poll = setInterval(refresh, 8000);
}

async function refresh() {
  try { me = (await api('/me')).user; deps = (await api('/deployments')).deployments; } catch { me = null; }
  nav(); me ? dash() : landing();
}

/* ---------- actions ---------- */
const A = {
  close,
  auth({ m }) {
    const s = m === 'signup';
    modal(`<div class="tabs"><button class="btn ${s ? '' : 'on'}" data-a="auth" data-m="login">Log in</button><button class="btn ${s ? 'on' : ''}" data-a="auth" data-m="signup">Sign up</button></div>
    <form id="af" data-m="${m}">${s ? '<label>Name</label><input name="name" required autocomplete="name">' : ''}<label>Email</label><input name="email" type="email" required autocomplete="email">
    <label>Password</label><input name="password" type="password" minlength="8" required autocomplete="${s ? 'new-password' : 'current-password'}"><button class="btn pri" style="width:100%">${s ? 'Create account' : 'Log in'}</button></form>`);
  },
  async logout() { await api('/logout', { method: 'POST' }); me = null; deps = []; clearInterval(poll); nav(); landing(); },
  async topup({ amt }) {
    if (!me) return A.auth({ m: 'signup' });
    const amount = +(amt || $('#amt').value);
    try { location.href = (await api('/topup', { body: { amount } })).url; } catch (e) { toast(e.message, 1); }
  },
  deploy({ id }) {
    if (!me) return A.auth({ m: 'signup' });
    const b = bots.find(x => x.id === id), ok = me.balance >= price;
    modal(`<h3>Deploy ${esc(b.name)}</h3><p style="color:var(--mut);margin:8px 0 16px">Cost ${ksh(price)} · Wallet ${ksh(me.balance)}</p>
    <p><b>1.</b> Get your Session ID on the pairing site:</p><p style="margin:8px 0 14px"><a class="btn sm" target="_blank" rel="noopener" href="${esc(b.pairUrl)}">Open pairing site ↗</a></p>
    <p><b>2.</b> Paste it here:</p><textarea id="sid" rows="4" placeholder="Session ID"></textarea>
    ${ok ? `<button class="btn pri" style="width:100%" data-a="confirm" data-id="${id}">Pay ${ksh(price)} & deploy</button>` : `<button class="btn pri" style="width:100%" data-a="topup" data-amt="${Math.max(price, price - me.balance)}">Top up ${ksh(price - me.balance)} to continue</button>`}`);
  },
  async confirm({ id }) {
    try { await api('/deploy', { body: { botId: id, sessionId: $('#sid').value } }); close(); toast('Deploying. Your bot will be live in a few minutes.'); refresh(); } catch (e) { toast(e.message, 1); }
  },
  async renew({ id }) { try { await api(`/deployments/${id}/renew`, { method: 'POST' }); toast('Renewed for 30 days'); refresh(); } catch (e) { toast(e.message, 1); } },
  async del({ id }) { if (!confirm('Delete this bot? This cannot be undone and is not refunded.')) return; try { await api('/deployments/' + id, { method: 'DELETE' }); refresh(); } catch (e) { toast(e.message, 1); } },
};
document.addEventListener('click', e => { const a = e.target.closest('[data-a]'); if (a && A[a.dataset.a]) A[a.dataset.a](a.dataset); else if (e.target.id === 'modal') close(); });
document.addEventListener('submit', async e => {
  if (e.target.id !== 'af') return; e.preventDefault();
  try { await api('/' + e.target.dataset.m, { body: Object.fromEntries(new FormData(e.target)) }); close(); await refresh(); toast('Welcome to BotFleet'); } catch (er) { toast(er.message, 1); }
});

/* ---------- background: neon network ---------- */
(() => {
  const c = $('#bg'), x = c.getContext('2d'); let W, H, P = [];
  const size = () => { W = c.width = innerWidth; H = c.height = innerHeight; P = Array.from({ length: Math.min(90, W / 14 | 0) }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .4, vy: (Math.random() - .5) * .4 })); };
  const draw = () => {
    x.clearRect(0, 0, W, H);
    for (const p of P) { p.x = (p.x + p.vx + W) % W; p.y = (p.y + p.vy + H) % H; x.fillStyle = 'rgba(0,240,255,.7)'; x.beginPath(); x.arc(p.x, p.y, 1.5, 0, 7); x.fill(); }
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) { const d = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y); if (d < 140) { x.strokeStyle = `rgba(138,92,255,${.28 * (1 - d / 140)})`; x.beginPath(); x.moveTo(P[i].x, P[i].y); x.lineTo(P[j].x, P[j].y); x.stroke(); } }
    if (!matchMedia('(prefers-reduced-motion:reduce)').matches) requestAnimationFrame(draw);
  };
  addEventListener('resize', size); size(); draw();
})();

/* ---------- boot ---------- */
(async () => {
  const d = await api('/bots'); bots = d.bots; price = d.price;
  const p = new URLSearchParams(location.search).get('paid');
  if (p) { history.replaceState({}, '', '/'); }
  await refresh();
  if (p === '1') toast('Payment received. Wallet updated.'); else if (p === '0') toast('Payment not confirmed yet. Refresh in a minute.', 1);
})();
