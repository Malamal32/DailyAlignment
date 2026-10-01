// DailyAlignment API. Cloudflare Access handles sign-in (email one-time code);
// this Worker trusts the email Access verified and syncs that person's journal.
// Everything that isn't /api/* is served from ./public.
const enc = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64urlText = s => new TextDecoder().decode(b64urlBytes(s));

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS days (user_id INTEGER NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, srv INTEGER NOT NULL, PRIMARY KEY (user_id, date))',
  'CREATE TABLE IF NOT EXISTS meta (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL, srv INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS days_srv ON days (user_id, srv)'
];
let ready = null; // tables are created on first use, once per Worker instance
const ensure = env => ready || (ready = env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).catch(e => { ready = null; throw e; }));

let jwks = null, jwksAt = 0;
async function accessEmail(req, env, info = {}) {
  const cookie = (req.headers.get('cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const tok = req.headers.get('cf-access-jwt-assertion') || (cookie && cookie[1]);
  if (!tok) { info.reason = 'No Cloudflare Access token on this request. Access is not protecting this URL.'; return null; }
  // Without TEAM_DOMAIN and POLICY_AUD set, fall back to the header Access adds.
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return (req.headers.get('cf-access-authenticated-user-email') || '').toLowerCase() || null;
  const [h, p, s] = tok.split('.'); if (!s) { info.reason = 'Access token is malformed.'; return null; }
  let header, payload; try { header = JSON.parse(b64urlText(h)); payload = JSON.parse(b64urlText(p)); } catch (e) { info.reason = 'Access token could not be read.'; return null; }
  if (!jwks || Date.now() - jwksAt > 3600e3) {
    const team = String(env.TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    jwks = (await (await fetch(`https://${team}/cdn-cgi/access/certs`)).json()).keys || []; jwksAt = Date.now();
  }
  const jwk = jwks.find(k => k.kid === header.kid); if (!jwk) { jwks = null; info.reason = 'Signing key not found. Check TEAM_DOMAIN in wrangler.jsonc.'; return null; }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), enc.encode(h + '.' + p)))) { info.reason = 'Access token signature did not verify.'; return null; }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.POLICY_AUD)) { info.reason = 'POLICY_AUD in wrangler.jsonc does not match this Access app. Paste the AUD tag again with the copy button.'; return null; }
  if (payload.exp && payload.exp * 1000 < Date.now()) { info.reason = 'Access sign-in expired.'; return null; }
  return String(payload.email || '').toLowerCase() || null;
}
async function userId(env, email) {
  const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (u) return u.id;
  await env.DB.prepare("INSERT OR IGNORE INTO users (email, salt, hash, created) VALUES (?, '', '', ?)").bind(email, Date.now()).run();
  return (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()).id;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const info = {}, out = { worker: 'running', database: env.DB ? 'bound' : 'MISSING: database_id is not set in wrangler.jsonc', teamDomain: env.TEAM_DOMAIN || '(empty)', audTag: env.POLICY_AUD ? 'set' : '(empty)', signedInAs: null };
      try {
        const email = await accessEmail(req, env, info);
        out.signedInAs = email || ('NOT VERIFIED: ' + (info.reason || 'unknown'));
        if (env.DB && email) {
          await ensure(env);
          const uid = await userId(env, email);
          const c = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(updated) AS last FROM days WHERE user_id = ? AND data != ''").bind(uid).first();
          out.database = 'connected'; out.daysSaved = c.n; out.lastChange = c.last ? new Date(c.last).toISOString() : null;
        }
      } catch (e) { out.error = e.message; }
      return json(out);
    }
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    if (!env.DB) return json({ error: 'The database is not set up yet.' }, 500);
    let body = {}; try { body = await req.json(); } catch (e) {}
    try {
      const info = {}, email = await accessEmail(req, env, info);
      if (!email) return json({ error: info.reason || 'Cloudflare Access is not on for this app yet.' }, 401);
      await ensure(env);
      const uid = await userId(env, email), now = Date.now();

      if (url.pathname === '/api/me') return json({ email });

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
