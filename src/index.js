// DailyAlignment API: email-code sign-in + sync. Everything that isn't /api/* is served from ./public.
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const bearer = req => { const h = req.headers.get('authorization') || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL, sent INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS days (user_id INTEGER NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, srv INTEGER NOT NULL, PRIMARY KEY (user_id, date))',
  'CREATE TABLE IF NOT EXISTS meta (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL, srv INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS days_srv ON days (user_id, srv)'
];
let ready = null; // tables are created on first use, once per Worker instance
const ensure = env => ready || (ready = env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).catch(e => { ready = null; throw e; }));

async function userFor(req, env) {
  const tok = bearer(req); if (!tok) return null;
  const row = await env.DB.prepare('SELECT user_id, expires FROM sessions WHERE token = ?').bind(await sha(tok)).first();
  return row && row.expires > Date.now() ? row.user_id : null;
}
async function newSession(env, uid) {
  const tok = rand(32);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').bind(await sha(tok), uid, Date.now() + 365 * 864e5).run();
  return tok;
}

async function sendCode(env, to, code) {
  const app = env.APP_NAME || 'DailyAlignment';
  const subject = `${code} is your ${app} code`;
  const text = `Your ${app} sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;color:#201e1d;background:#f3f2f2;padding:32px;font-size:16px;line-height:1.5"><p style="margin:0 0 8px">Your ${app} sign-in code</p><p style="font-size:36px;letter-spacing:8px;font-weight:600;margin:0 0 16px">${code}</p><p style="margin:0;color:#5c5856">It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p></div>`;
  if (!env.MAIL_FROM) throw Object.assign(new Error('MAIL_FROM is not set in wrangler.jsonc.'), { setup: true });
  if (env.EMAIL) { await env.EMAIL.send({ to, from: env.MAIL_FROM, subject, text, html }); return; }
  if (env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text, html }) });
    if (!r.ok) throw new Error('Resend: ' + (await r.text()).slice(0, 200));
    return;
  }
  throw Object.assign(new Error('No email sender is set up (see README).'), { setup: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    if (!env.DB) return json({ error: 'The database is not set up yet (see README).' }, 500);
    let body = {}; try { body = await req.json(); } catch (e) {}
    try {
      await ensure(env);
      const now = Date.now();

      if (url.pathname === '/api/code') {
        const email = String(body.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
        const prev = await env.DB.prepare('SELECT sent FROM codes WHERE email = ?').bind(email).first();
        if (prev && prev.sent > now - 45000) return json({ error: 'A code was just sent. Wait a moment before asking for another.' }, 429);
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
        await env.DB.prepare('INSERT INTO codes (email, hash, expires, attempts, sent) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, attempts = 0, sent = excluded.sent')
          .bind(email, await sha(email + ':' + code), now + 10 * 60000, now).run();
        try { await sendCode(env, email, code); }
        catch (e) {
          await env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(email).run();
          return json({ error: (e.setup ? 'Email is not set up on the server: ' : "Couldn't send the email: ") + (e.message || 'unknown error') }, 502);
        }
        return json({ ok: true });
      }

      if (url.pathname === '/api/verify') {
        const email = String(body.email || '').trim().toLowerCase(), code = String(body.code || '').replace(/\D/g, '');
        const row = await env.DB.prepare('SELECT hash, expires, attempts FROM codes WHERE email = ?').bind(email).first();
        if (!row || row.expires < now) return json({ error: 'That code has expired. Ask for a new one.' }, 401);
        if (row.attempts >= 5) return json({ error: 'Too many tries. Ask for a new code.' }, 429);
        if (!same(await sha(email + ':' + code), row.hash)) {
          await env.DB.prepare('UPDATE codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
          return json({ error: "That code isn't right. Check the email and try again." }, 401);
        }
        await env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(email).run();
        let u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (!u) { const res = await env.DB.prepare("INSERT INTO users (email, salt, hash, created) VALUES (?, '', '', ?)").bind(email, now).run(); u = { id: res.meta.last_row_id }; }
        return json({ token: await newSession(env, u.id), email });
      }

      const uid = await userFor(req, env);
      if (!uid) return json({ error: 'Please sign in again.' }, 401);

      if (url.pathname === '/api/logout') {
        await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha(bearer(req))).run();
        return json({ ok: true });
      }

      if (url.pathname === '/api/sync') {
        const stmts = [];
        for (const d of (Array.isArray(body.days) ? body.days.slice(0, 40) : [])) {
          if (typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.data !== 'string' || d.data.length > 200000) continue;
          stmts.push(env.DB.prepare('INSERT INTO days (user_id, date, data, updated, srv) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data, updated = excluded.updated, srv = excluded.srv WHERE excluded.updated > days.updated').bind(uid, d.date, d.data, Number(d.updated) || 0, now));
        }
        if (body.meta && typeof body.meta.data === 'string' && body.meta.data.length < 200000) {
          stmts.push(env.DB.prepare('INSERT INTO meta (user_id, data, updated, srv) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated, srv = excluded.srv WHERE excluded.updated > meta.updated').bind(uid, body.meta.data, Number(body.meta.updated) || 0, now));
        }
        if (stmts.length) await env.DB.batch(stmts);
        const since = Number(body.since) || 0;
        const rows = await env.DB.prepare('SELECT date, data, updated FROM days WHERE user_id = ? AND srv >= ?').bind(uid, since).all();
        const meta = await env.DB.prepare('SELECT data, updated FROM meta WHERE user_id = ? AND srv >= ?').bind(uid, since).first();
        return json({ now, days: rows.results || [], meta: meta || null });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      return json({ error: 'Server error: ' + (e.message || 'unknown') }, 500);
    }
  }
};
