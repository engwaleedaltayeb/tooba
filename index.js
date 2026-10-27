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

// حد المعدّل (Workers Rate Limiting). لو الإعداد مش موجود في wrangler.toml بيتجاهل ولا يكسر شيئًا
async function limited(env, name, key) {
  const lim = env[name];
  if (!lim || !key) return false;
  try { const r = await lim.limit({ key }); return !r.success; } catch (e) { return false; }
}
const WRITE_PATHS = new Set(['/api/pair/new', '/api/pair/send', '/api/sync/create', '/api/subscribe', '/api/unsubscribe']);

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

async function readBody(request, max = 4096) {
  const text = await request.text();
  if (text.length > max) throw new Error('too large');
  return JSON.parse(text);
}

async function sha256hex(t) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t)));
  return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
}
// تطبيق أندرويد (Capacitor) يعمل من https://localhost ويكلّم الموقع بعنوان كامل
const ALLOWED_ORIGINS = ['https://localhost', 'https://toobaapp.com'];
function withCors(res, origin) {
  const r = new Response(res.body, res);
  if (ALLOWED_ORIGINS.includes(origin)) {
    r.headers.set('Access-Control-Allow-Origin', origin);
    r.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Secret');
    r.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    r.headers.set('Access-Control-Max-Age', '86400');
    r.headers.append('Vary', 'Origin');
  }
  return r;
}
async function cleanup(env, now) {
  const s = Math.floor(now.getTime() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pairs WHERE created < ?1').bind(s - 300),
    env.DB.prepare('DELETE FROM groups WHERE updated < ?1').bind(s - 365 * 86400),
  ]);
}

async function handleFetch(request, env) {
  const url = new URL(request.url);

  // ---------- حد المعدّل ----------
  // الكتابة والربط: لكل IP. الاستعلام الدوري (pair/get وsync): لكل كود ربط أو سرّ مجموعة، عشان الشبكات المشتركة (CGNAT) ما تتأثرش
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (WRITE_PATHS.has(url.pathname) && request.method === 'POST') {
    if (await limited(env, 'RL_WRITE', ip)) return json({ error: 'rate' }, 429);
  } else if (url.pathname === '/api/pair/get') {
    if (await limited(env, 'RL_POLL', 'p:' + (url.searchParams.get('id') || ip))) return json({ error: 'rate' }, 429);
  } else if (url.pathname === '/api/sync') {
    if (await limited(env, 'RL_POLL', 's:' + (request.headers.get('X-Secret') || ip))) return json({ error: 'rate' }, 429);
  }

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

  // ---------- الربط والمزامنة بين الأجهزة (الخادم لا يقرأ شيئًا: كله مشفّر على الأجهزة) ----------
  const ID22 = /^[A-Za-z0-9_-]{22}$/, SEC43 = /^[A-Za-z0-9_-]{43}$/, PUB87 = /^[A-Za-z0-9_-]{87}$/, B64U = /^[A-Za-z0-9_-]+$/;
  const nowS = () => Math.floor(Date.now() / 1000);

  if (url.pathname === '/api/pair/new' && request.method === 'POST') {
    let b; try { b = await readBody(request); } catch (e) { return json({ error: 'bad body' }, 400); }
    if (!ID22.test(b.id || '') || !PUB87.test(b.pub || '')) return json({ error: 'bad' }, 400);
    try { await env.DB.prepare('INSERT INTO pairs(id, pub, blob, created) VALUES(?1, ?2, NULL, ?3)').bind(b.id, b.pub, nowS()).run(); }
    catch (e) { return json({ error: 'exists' }, 409); }
    return json({ ok: true });
  }
  if (url.pathname === '/api/pair/send' && request.method === 'POST') {
    let b; try { b = await readBody(request); } catch (e) { return json({ error: 'bad body' }, 400); }
    if (!ID22.test(b.id || '') || !PUB87.test(b.eph || '') || !B64U.test(b.iv || '') || !B64U.test(b.ct || '') || b.ct.length > 1000 || b.iv.length > 40) return json({ error: 'bad' }, 400);
    const row = await env.DB.prepare('SELECT blob, created FROM pairs WHERE id = ?1').bind(b.id).first();
    if (!row || nowS() - row.created > 300) return json({ error: 'expired' }, 410);
    if (row.blob) return json({ error: 'used' }, 409);
    await env.DB.prepare('UPDATE pairs SET blob = ?2 WHERE id = ?1 AND blob IS NULL').bind(b.id, JSON.stringify({ eph: b.eph, iv: b.iv, ct: b.ct })).run();
    return json({ ok: true });
  }
  if (url.pathname === '/api/pair/get' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!ID22.test(id)) return json({ error: 'bad' }, 400);
    const row = await env.DB.prepare('SELECT blob, created FROM pairs WHERE id = ?1').bind(id).first();
    if (!row || nowS() - row.created > 300) return json({ ready: false, gone: true });
    if (!row.blob) return json({ ready: false });
    await env.DB.prepare('DELETE FROM pairs WHERE id = ?1').bind(id).run();   // يُسلَّم مرة واحدة ثم يُمسح
    return json({ ready: true, blob: JSON.parse(row.blob) });
  }
  if (url.pathname === '/api/sync/create' && request.method === 'POST') {
    let b; try { b = await readBody(request); } catch (e) { return json({ error: 'bad body' }, 400); }
    if (!ID22.test(b.gid || '') || !SEC43.test(b.secret || '')) return json({ error: 'bad' }, 400);
    try { await env.DB.prepare('INSERT INTO groups(gid, secret_hash, ver, blob, created, updated) VALUES(?1, ?2, 0, NULL, ?3, ?3)').bind(b.gid, await sha256hex(b.secret), nowS()).run(); }
    catch (e) { return json({ error: 'exists' }, 409); }
    return json({ ok: true });
  }
  if (url.pathname === '/api/sync') {
    const secret = request.headers.get('X-Secret') || '';
    if (!SEC43.test(secret)) return json({ error: 'auth' }, 401);
    const hash = await sha256hex(secret);
    if (request.method === 'GET') {
      const gid = url.searchParams.get('gid') || '', since = parseInt(url.searchParams.get('since'), 10);
      if (!ID22.test(gid)) return json({ error: 'bad' }, 400);
      const g = await env.DB.prepare('SELECT secret_hash, ver, blob FROM groups WHERE gid = ?1').bind(gid).first();
      if (!g) return json({ error: 'gone' }, 404);
      if (g.secret_hash !== hash) return json({ error: 'auth' }, 401);
      if (g.ver === since) return json({ same: true, ver: g.ver });
      return json({ ver: g.ver, blob: g.blob });
    }
    if (request.method === 'PUT') {
      let b; try { b = await readBody(request, 65536); } catch (e) { return json({ error: 'bad body' }, 400); }
      if (!ID22.test(b.gid || '') || !Number.isInteger(b.base) || typeof b.blob !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(b.blob)) return json({ error: 'bad' }, 400);
      const g = await env.DB.prepare('SELECT secret_hash FROM groups WHERE gid = ?1').bind(b.gid).first();
      if (!g) return json({ error: 'gone' }, 404);
      if (g.secret_hash !== hash) return json({ error: 'auth' }, 401);
      const r = await env.DB.prepare('UPDATE groups SET blob = ?3, ver = ver + 1, updated = ?4 WHERE gid = ?1 AND ver = ?2').bind(b.gid, b.base, b.blob, nowS()).run();
      if (!r.meta || !r.meta.changes) return json({ error: 'conflict' }, 409);   // compare-and-set: جهاز آخر سبقك
      return json({ ok: true, ver: b.base + 1 });
    }
    if (request.method === 'DELETE') {
      const gid = url.searchParams.get('gid') || '';
      if (!ID22.test(gid)) return json({ error: 'bad' }, 400);
      await env.DB.prepare('DELETE FROM groups WHERE gid = ?1 AND secret_hash = ?2').bind(gid, hash).run();
      return json({ ok: true });
    }
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
  fetch: async (request, env) => {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin);
    let res;
    try { res = await handleFetch(request, env); } catch (e) { res = json({ error: 'server' }, 500); }
    return withCors(res, origin);
  },
  scheduled: (event, env, ctx) => {
    const now = new Date(event.scheduledTime);
    ctx.waitUntil(runSchedule(env, now).catch(() => {}).then(() => cleanup(env, now)).catch(() => {}));
  },
};
