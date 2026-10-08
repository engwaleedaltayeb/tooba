const VERSION = 'tooba-v1.65';
const CORE = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/badge-96.png',
  '/apple-touch-icon.png', '/favicon.ico', '/favicon-32.png', '/favicon-64.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((cache) =>
      Promise.allSettled(CORE.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // الصفحة نفسها: الشبكة أولًا، ولو مفيش نت من الكاش
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // باقي الملفات (الأيقونات والخطوط): من الكاش فورًا وتتحدّث في الخلفية
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin === location.origin || isFont) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const fresh = fetch(req)
          .then((res) => {
            if (res && (res.ok || res.type === 'opaque')) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
  }
});

// ---------- إشعارات التذكير (Web Push بدون نص: الصباح قبل 1 ظهرًا بتوقيت الجهاز) ----------
self.addEventListener('push', (e) => {
  const morning = new Date().getHours() < 13;
  e.waitUntil(self.registration.showNotification(morning ? 'أذكار الصباح' : 'أذكار المساء', {
    body: morning ? 'حان وقت أذكار الصباح، اضغط للبدء.' : 'حان وقت أذكار المساء، اضغط للبدء.',
    icon: '/icon-192.png',
    // أيقونة شريط الحالة في أندرويد: لازم تكون أحادية اللون بخلفية شفافة وإلا تظهر مربعًا أبيض
    badge: '/badge-96.png',
    tag: 'tooba-reminder',
    lang: 'ar',
    dir: 'rtl',
    data: { m: morning ? 'morning' : 'evening' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const m = (e.notification.data && e.notification.data.m) || 'morning';
  const target = '/?m=' + m;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          return c.focus().then((w) => (w && w.navigate ? w.navigate(target) : null));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
