// Jerry's Lotto 47 board: static page plus a small API so Jerry can enter new draws himself.
//
// Static files in ./public are served by Cloudflare's asset handler. Requests to /api/* run this Worker.
// Entered draws live in a SQLite-backed Durable Object (one instance named "main"), so there is no
// separate database to create. draws.json stays as the history up to Oct 17, 2026; the page merges
// the entered draws on top of it (an entered draw replaces a draws.json draw on the same date).
//
// Writes need the entry PIN, stored as the Worker secret ENTRY_PIN (never in this repo).
// Five wrong PINs in a row lock entry for 15 minutes.

import { DurableObject } from 'cloudflare:workers';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' },
});

// Today's date in Michigan, as YYYY-MM-DD
const todayMI = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Check a draw sent from the page. Returns { draw } or { error } with a message Jerry can read.
export function checkDraw(body) {
  const date = String(body?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) return { error: 'Please pick the date of the drawing.' };
  if (new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) return { error: 'That date does not exist.' };
  const wd = new Date(date + 'T00:00:00Z').getUTCDay();
  if (wd !== 3 && wd !== 6) return { error: 'Lotto 47 is drawn on Wednesdays and Saturdays. That date is neither.' };
  if (date > todayMI()) return { error: 'That drawing has not happened yet.' };
  if (date < '2025-01-01') return { error: 'The board starts in January 2025.' };
  const raw = Array.isArray(body?.numbers) ? body.numbers : [];
  if (raw.length !== 6) return { error: 'Please fill in all six numbers.' };
  const nums = raw.map((x) => Number(x));
  if (nums.some((x) => !Number.isInteger(x) || x < 1 || x > 47)) return { error: 'Each number must be from 1 to 47.' };
  if (new Set(nums).size !== 6) return { error: 'The same number is in there twice. Each of the six is different.' };
  nums.sort((a, b) => a - b);
  return { draw: { date, n1: nums[0], n2: nums[1], n3: nums[2], n4: nums[3], n5: nums[4], n6: nums[5] } };
}

export class DrawStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS draws (
      date TEXT PRIMARY KEY, n1 INTEGER NOT NULL, n2 INTEGER NOT NULL, n3 INTEGER NOT NULL,
      n4 INTEGER NOT NULL, n5 INTEGER NOT NULL, n6 INTEGER NOT NULL, entered_at TEXT NOT NULL)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS pin_guard (id INTEGER PRIMARY KEY CHECK (id = 1), fails INTEGER NOT NULL, locked_until INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO pin_guard (id, fails, locked_until) VALUES (1, 0, 0)');
  }

  list() {
    return this.sql.exec('SELECT date, n1, n2, n3, n4, n5, n6, entered_at FROM draws ORDER BY date').toArray();
  }

  // Returns { ok: true } or { ok: false, locked: bool, minutes?: n }
  async checkPin(given, expected) {
    const g = this.sql.exec('SELECT fails, locked_until FROM pin_guard WHERE id = 1').one();
    const now = Date.now();
    if (g.locked_until > now) return { ok: false, locked: true, minutes: Math.ceil((g.locked_until - now) / 60000) };
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
    const same = crypto.subtle.timingSafeEqual(a, b);
    if (same) {
      this.sql.exec('UPDATE pin_guard SET fails = 0, locked_until = 0 WHERE id = 1');
      return { ok: true };
    }
    const fails = g.fails + 1;
    if (fails >= MAX_FAILS) {
      this.sql.exec('UPDATE pin_guard SET fails = 0, locked_until = ? WHERE id = 1', now + LOCK_MS);
      return { ok: false, locked: true, minutes: LOCK_MS / 60000 };
    }
    this.sql.exec('UPDATE pin_guard SET fails = ? WHERE id = 1', fails);
    return { ok: false, locked: false };
  }

  save(d) {
    const at = new Date().toISOString();
    this.sql.exec(`INSERT INTO draws (date, n1, n2, n3, n4, n5, n6, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET n1 = excluded.n1, n2 = excluded.n2, n3 = excluded.n3, n4 = excluded.n4,
      n5 = excluded.n5, n6 = excluded.n6, entered_at = excluded.entered_at`, d.date, d.n1, d.n2, d.n3, d.n4, d.n5, d.n6, at);
    return { ...d, entered_at: at };
  }

  remove(date) {
    const had = this.sql.exec('SELECT COUNT(*) AS c FROM draws WHERE date = ?', date).one().c > 0;
    if (had) this.sql.exec('DELETE FROM draws WHERE date = ?', date);
    return had;
  }
}

async function api(request, env, url) {
  const store = env.DRAWS.get(env.DRAWS.idFromName('main'));
  const pinSet = typeof env.ENTRY_PIN === 'string' && env.ENTRY_PIN.length > 0;
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/draws' && request.method === 'GET') {
    return json({ draws: await store.list(), entry_ready: pinSet });
  }

  // Everything below changes data and needs the PIN
  if (!['POST', 'DELETE'].includes(request.method)) return json({ error: 'Not allowed.' }, 405);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'Not allowed.' }, 403);
  if (!pinSet) return json({ error: 'Entering draws is not switched on yet. Mike needs to set the PIN.' }, 503);
  const pin = await store.checkPin(request.headers.get('x-entry-pin') || '', env.ENTRY_PIN);
  if (!pin.ok) {
    return pin.locked
      ? json({ error: `Too many wrong PINs. Entry is paused for ${pin.minutes} minute${pin.minutes === 1 ? '' : 's'}.`, pin: 'locked' }, 429)
      : json({ error: 'That PIN is not right.', pin: 'wrong' }, 401);
  }

  if (path === '/api/pin' && request.method === 'POST') return json({ ok: true });

  if (path === '/api/draws' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Something went wrong sending that. Please try again.' }, 400); }
    const r = checkDraw(body);
    if (r.error) return json({ error: r.error }, 400);
    return json({ ok: true, draw: await store.save(r.draw) });
  }

  const m = path.match(/^\/api\/draws\/(\d{4}-\d{2}-\d{2})$/);
  if (m && request.method === 'DELETE') {
    const gone = await store.remove(m[1]);
    return gone ? json({ ok: true }) : json({ error: 'There is no entered draw on that date.' }, 404);
  }

  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url); } catch (e) { console.error(e); return json({ error: 'Something went wrong on the server. Please try again.' }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
