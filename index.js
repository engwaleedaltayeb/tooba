// طوبى — خادم إشعارات التذكير (Cloudflare Worker + D1)
// - POST /api/subscribe    : تسجيل اشتراك الجهاز مع أوقات التذكير والمنطقة الزمنية
// - POST /api/unsubscribe  : حذف الاشتراك
// - GET  /api/key          : المفتاح العام (VAPID) للتطبيق
// - Cron كل دقيقة          : يرسل إشعارًا (Web Push بدون نص) لكل من حان وقته
// لا نخزّن أي اسم أو بريد، فقط: رابط الاشتراك + الوقتين + المنطقة الزمنية.

const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PER_RUN = 45; // حد الباقة المجانية: 50 طلب خارجي في كل تشغيل
const SUBJECT = 'mailto:tooba.app.support@gmail.com';

const enc = new TextEncoder();

export function bytesToB64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uToBytes(str) {
  const p = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob((str + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function importVapidKey(env) {
  const pub = b64uToBytes(env.VAPID_PUBLIC); // 65 بايت: 0x04 | x | y
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    d: env.VAPID_PRIVATE, ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function vapidJwt(audience, key) {
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUBJECT,
  })));
  const data = header + '.' + payload;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(data)));
  return data + '.' + bytesToB64u(sig);
}

export function localHM(tz, date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const h = parts.find((p) => p.type === 'hour').value;
  const m = parts.find((p) => p.type === 'minute').value;
  return h + ':' + m;
}

function validTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (e) { return false; }
}

function validEndpoint(ep) {
  if (typeof ep !== 'string' || ep.length > 1000) return false;
  try {
    const u = new URL(ep);
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
  } catch (e) { return false; }
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error('too large');
  return JSON.parse(text);
}

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/key' && request.method === 'GET') {
    return new Response(env.VAPID_PUBLIC, {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' },
    });
  }

  if (url.pathname === '/api/subscribe' && request.method === 'POST') {
    let b;
    try { b = await readBody(request); } catch (e) { return json({ error: 'bad body' }, 400); }
    const m = b.m == null ? null : b.m;
    const e = b.e == null ? null : b.e;
    if (!validEndpoint(b.endpoint)) return json({ error: 'bad endpoint' }, 400);
    if (!validTz(b.tz)) return json({ error: 'bad tz' }, 400);
    if ((m !== null && !TIME_RE.test(m)) || (e !== null && !TIME_RE.test(e)) || (m === null && e === null)) {
      return json({ error: 'bad times' }, 400);
    }
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO subs(endpoint, m_time, e_time, tz, updated) VALUES(?1, ?2, ?3, ?4, ?5) ' +
        'ON CONFLICT(endpoint) DO UPDATE SET m_time = excluded.m_time, e_time = excluded.e_time, tz = excluded.tz, updated = excluded.updated'
      ).bind(b.endpoint, m, e, b.tz, Math.floor(Date.now() / 1000)),
      env.DB.prepare('INSERT OR IGNORE INTO tzs(tz) VALUES(?1)').bind(b.tz),
    ]);
    return json({ ok: true });
  }

  if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
    let b;
    try { b = await readBody(request); } catch (e) { return json({ error: 'bad body' }, 400); }
    if (typeof b.endpoint !== 'string') return json({ error: 'bad endpoint' }, 400);
    await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?1').bind(b.endpoint).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

export async function runSchedule(env, now) {
  const tzRows = (await env.DB.prepare('SELECT tz FROM tzs').all()).results || [];
  if (!tzRows.length) return { sent: 0 };

  const queries = [];
  for (const { tz } of tzRows) {
    let hm;
    try { hm = localHM(tz, now); } catch (e) { continue; }
    queries.push(env.DB.prepare('SELECT endpoint FROM subs WHERE tz = ?1 AND (m_time = ?2 OR e_time = ?2)').bind(tz, hm));
  }
  if (!queries.length) return { sent: 0 };
  const batches = await env.DB.batch(queries);
  const endpoints = [];
  for (const r of batches) for (const row of (r.results || [])) endpoints.push(row.endpoint);
  if (!endpoints.length) return { sent: 0 };

  const key = await importVapidKey(env);
  const jwts = new Map();
  const dead = [];
  const batch = endpoints.slice(0, MAX_PER_RUN);

  await Promise.allSettled(batch.map(async (ep) => {
    let u;
    try { u = new URL(ep); } catch (e) { dead.push(ep); return; }
    let jwt = jwts.get(u.origin);
    if (!jwt) { jwt = await vapidJwt(u.origin, key); jwts.set(u.origin, jwt); }
    const res = await fetch(ep, {
      method: 'POST',
      headers: {
        Authorization: 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC,
        TTL: '1800',
        Urgency: 'high',
      },
    });
    if (res.status === 404 || res.status === 410) dead.push(ep);
  }));

  if (dead.length) {
    await env.DB.batch(dead.slice(0, 40).map((ep) => env.DB.prepare('DELETE FROM subs WHERE endpoint = ?1').bind(ep)));
  }
  return { sent: batch.length, dropped: Math.max(0, endpoints.length - batch.length), dead: dead.length };
}

export default {
  fetch: (request, env) => handleFetch(request, env),
  scheduled: (event, env, ctx) => { ctx.waitUntil(runSchedule(env, new Date(event.scheduledTime))); },
};
