// DailyAlignment API. Cloudflare Access handles sign-in (email one-time code);
// this Worker trusts the email Access verified, decides whether that person is a
// member (invite or open registration) and syncs their journal.
// Everything that isn't /api/* is served from ./public.
const enc = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64urlText = s => new TextDecoder().decode(b64urlBytes(s));

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS days (user_id INTEGER NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, srv INTEGER NOT NULL, PRIMARY KEY (user_id, date))',
  'CREATE TABLE IF NOT EXISTS meta (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL, srv INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS days_srv ON days (user_id, srv)',
  'CREATE TABLE IF NOT EXISTS days_history (user_id INTEGER NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, replaced INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS members (email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', joined INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, expires INTEGER NOT NULL, used_by TEXT NOT NULL DEFAULT '', used_at INTEGER NOT NULL DEFAULT 0)",
  'CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)'
];
let ready = null; // tables are created on first use, once per Worker instance
const ensure = env => ready || (ready = env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).then(() => migrate(env)).catch(e => { ready = null; throw e; }));
// Everyone who signed in before the member list existed joins it once, as an active member.
async function migrate(env) {
  if (await env.DB.prepare("SELECT v FROM settings WHERE k = 'members_v1'").first()) return;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO members (email, name, status, joined, seen) SELECT email, '', 'active', created, 0 FROM users"),
    env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('members_v1', '1')")
  ]);
}
const setting = async (env, k, dflt) => ((await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first()) || { v: dflt }).v;
const adminList = env => String(env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
const INVITE_DAYS = 14;
const GATE = {
  invite_only: 'DailyAlignment is invite-only. Ask for an invite link.',
  removed: 'This account no longer has access to DailyAlignment.',
  used: 'This invite link has already been used.',
  expired: 'This invite link has expired.',
  wrong_email: 'This invite is for a different email address.'
};
// Decide whether a verified email may use the app. Returns { admin, name } or { gate }.
async function admit(env, email, invite) {
  const now = Date.now(), listed = adminList(env), named = listed.includes(email);
  let m = await env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(email).first();
  if (m && m.status === 'removed') {
    if (!named) return { gate: 'removed' };
    await env.DB.prepare("UPDATE members SET status = 'active' WHERE email = ?").bind(email).run(); m.status = 'active';
  }
  if (!m) {
    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first()).n;
    let name = '';
    if (!named && count > 0) {
      const tok = String(invite || '').slice(0, 80);
      const claim = tok ? await env.DB.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE token = ? AND used_by = '' AND expires > ? AND (email = '' OR email = ?)").bind(email, now, tok, now, email).run() : null;
      if (claim && claim.meta && claim.meta.changes) name = ((await env.DB.prepare('SELECT name FROM invites WHERE token = ?').bind(tok).first()) || {}).name || '';
      else if ((await setting(env, 'registration', 'invite')) !== 'open') {
        const inv = tok ? await env.DB.prepare('SELECT * FROM invites WHERE token = ?').bind(tok).first() : null;
        return { gate: !inv ? 'invite_only' : inv.used_by ? 'used' : inv.expires <= now ? 'expired' : 'wrong_email' };
      }
    }
    await env.DB.prepare("INSERT OR IGNORE INTO members (email, name, status, joined, seen) VALUES (?, ?, 'active', ?, ?)").bind(email, name, now, now).run();
    m = { email, name, status: 'active', joined: now, seen: now };
  } else if (now - (m.seen || 0) > 300e3) await env.DB.prepare('UPDATE members SET seen = ? WHERE email = ?').bind(now, email).run();
  return { admin: await isAdmin(env, email), name: m.name || '' };
}
// ADMIN_EMAILS in wrangler.jsonc names the admins. Left empty, the earliest member is the admin.
async function isAdmin(env, email) {
  const listed = adminList(env); if (listed.length) return listed.includes(email);
  const first = await env.DB.prepare("SELECT email FROM members WHERE status = 'active' ORDER BY joined ASC, rowid ASC LIMIT 1").first();
  return !!first && first.email === email;
}
const gateRes = (gate, email) => json({ error: GATE[gate] || GATE.invite_only, gate, email }, 403);
const token = () => { const b = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

async function adminApi(path, body, env, email) {
  const now = Date.now();
  if (path === 'list') {
    const rows = await env.DB.prepare("SELECT m.email, m.name, m.status, m.joined, m.seen, COALESCE(d.n, 0) AS days FROM members m LEFT JOIN users u ON u.email = m.email LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM days WHERE data != '' GROUP BY user_id) d ON d.user_id = u.id ORDER BY m.joined ASC").all();
    const members = [];
    for (const r of rows.results || []) members.push({ ...r, admin: r.status === 'active' && await isAdmin(env, r.email) });
    const inv = await env.DB.prepare("SELECT token, name, email, created, expires FROM invites WHERE used_by = '' AND expires > ? ORDER BY created DESC").bind(now).all();
    return json({ me: email, registration: await setting(env, 'registration', 'invite'), members, invites: inv.results || [] });
  }
  if (path === 'invite') {
    const name = String(body.name || '').trim().slice(0, 80), to = String(body.email || '').trim().toLowerCase().slice(0, 200);
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: 'That email address doesn\'t look right.' }, 400);
    if (to && await env.DB.prepare("SELECT 1 FROM members WHERE email = ? AND status = 'active'").bind(to).first()) return json({ error: to + ' is already a member.' }, 400);
    const t = token(), expires = now + INVITE_DAYS * 864e5;
    await env.DB.prepare('INSERT INTO invites (token, name, email, created, expires) VALUES (?, ?, ?, ?, ?)').bind(t, name, to, now, expires).run();
    return json({ token: t, expires });
  }
  if (path === 'cancel') { await env.DB.prepare("DELETE FROM invites WHERE token = ? AND used_by = ''").bind(String(body.token || '')).run(); return json({ ok: true }); }
  if (path === 'registration') {
    const mode = body.mode === 'open' ? 'open' : 'invite';
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('registration', ?)").bind(mode).run();
    return json({ registration: mode });
  }
  if (path === 'member') {
    const who = String(body.email || '').toLowerCase(), act = body.action;
    const m = await env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(who).first();
    if (!m) return json({ error: 'No member with that email.' }, 404);
    if (act === 'rename') { await env.DB.prepare('UPDATE members SET name = ? WHERE email = ?').bind(String(body.name || '').trim().slice(0, 80), who).run(); return json({ ok: true }); }
    if (who === email || adminList(env).includes(who)) return json({ error: 'Admins can\'t be removed here. Take them out of ADMIN_EMAILS in wrangler.jsonc first.' }, 400);
    if (act === 'remove' || act === 'restore') { await env.DB.prepare('UPDATE members SET status = ? WHERE email = ?').bind(act === 'remove' ? 'removed' : 'active', who).run(); return json({ ok: true }); }
    if (act === 'purge') {
      if (m.status !== 'removed') return json({ error: 'Remove the member before deleting their journal.' }, 400);
      const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(who).first(), q = [];
      if (u) ['days', 'meta', 'days_history'].forEach(tb => q.push(env.DB.prepare(`DELETE FROM ${tb} WHERE user_id = ?`).bind(u.id)));
      q.push(env.DB.prepare('DELETE FROM users WHERE email = ?').bind(who), env.DB.prepare('DELETE FROM members WHERE email = ?').bind(who));
      await env.DB.batch(q); return json({ ok: true });
    }
  }
  return json({ error: 'Not found.' }, 404);
}

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
// Merge two versions of the same day so an edit on one device never wipes an entry from another.
function mergeDay(a, b) {
  const del = { ...(a.del || {}) };
  Object.entries(b.del || {}).forEach(([k, v]) => { if (!(del[k] >= v)) del[k] = v; });
  const byId = new Map();
  [...(a.entries || []), ...(b.entries || [])].forEach(e => { if (!e || e.id == null) return; const cur = byId.get(e.id); if (!cur || (e.u || 0) > (cur.u || 0)) byId.set(e.id, e); });
  const entries = [...byId.values()].filter(e => !(del[e.id] != null && del[e.id] >= (e.u || 0))).sort((x, y) => (x.min || 0) - (y.min || 0));
  const ac = a.cu || 0, bc = b.cu || 0, useB = bc > ac || (bc === ac && !!b.checkin && !a.checkin), ck = useB ? b : a;
  const sky = a.pos ? a : b;
  return { ...a, ...b, mood: ck.mood, chakras: ck.chakras, checkin: !!ck.checkin, checkinTime: ck.checkinTime || '', cu: Math.max(ac, bc), entries, del, pos: sky.pos, rx: sky.rx, phase: sky.phase, asp: sky.asp };
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
    if (url.pathname === '/api/history' && req.method === 'GET') {
      const email = await accessEmail(req, env); if (!email || !env.DB) return json({ error: 'Not signed in.' }, 401);
      await ensure(env); const ok = await admit(env, email); if (ok.gate) return gateRes(ok.gate, email);
      const uid = await userId(env, email), date = url.searchParams.get('date') || '';
      const rows = await env.DB.prepare('SELECT date, data, replaced FROM days_history WHERE user_id = ? AND (? = \'\' OR date = ?) ORDER BY replaced DESC LIMIT 50').bind(uid, date, date).all();
      return json((rows.results || []).map(r => { let v = null; try { v = JSON.parse(r.data); } catch (e) {} return { date: r.date, replaced: new Date(r.replaced).toISOString(), entries: v && v.entries ? v.entries.map(e => ({ id: e.id, min: e.min, text: e.text, mood: e.mood || null })) : [] }; }));
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const info = {}, out = { worker: 'running', database: env.DB ? 'bound' : 'MISSING: database_id is not set in wrangler.jsonc', teamDomain: env.TEAM_DOMAIN || '(empty)', audTag: env.POLICY_AUD ? 'set' : '(empty)', signedInAs: null };
      try {
        const email = await accessEmail(req, env, info);
        out.signedInAs = email || ('NOT VERIFIED: ' + (info.reason || 'unknown'));
        if (env.DB && email) {
          await ensure(env);
          const ok = await admit(env, email); out.member = ok.gate ? 'NO: ' + GATE[ok.gate] : ok.admin ? 'admin' : 'member';
          if (ok.gate) return json(out);
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
      const ok = await admit(env, email, body.invite);
      if (ok.gate) return gateRes(ok.gate, email);
      if (url.pathname.startsWith('/api/admin/')) return ok.admin ? adminApi(url.pathname.slice(11), body, env, email) : json({ error: 'Only an admin can do that.' }, 403);
      const uid = await userId(env, email), now = Date.now();

      if (url.pathname === '/api/me') return json({ email, name: ok.name, admin: ok.admin });

      if (url.pathname === '/api/sync') {
        const stmts = [];
        for (const d of (Array.isArray(body.days) ? body.days.slice(0, 40) : [])) {
          if (typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.data !== 'string' || d.data.length > 200000) continue;
          const ex = await env.DB.prepare('SELECT data, updated FROM days WHERE user_id = ? AND date = ?').bind(uid, d.date).first();
          let data = d.data, updated = Number(d.updated) || 0;
          if (ex) {
            if (d.data === '' || ex.data === '') { if (updated <= ex.updated) continue; } // whole-day delete or restore: newest wins
            else { try { data = JSON.stringify(mergeDay(JSON.parse(ex.data), JSON.parse(d.data))); } catch (e) { if (updated <= ex.updated) continue; } updated = Math.max(updated, ex.updated); }
            if (ex.data && ex.data !== data) stmts.push(env.DB.prepare('INSERT INTO days_history (user_id, date, data, replaced) VALUES (?, ?, ?, ?)').bind(uid, d.date, ex.data, now));
          }
          stmts.push(env.DB.prepare('INSERT INTO days (user_id, date, data, updated, srv) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data, updated = excluded.updated, srv = excluded.srv').bind(uid, d.date, data, updated, now));
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
