/* ============================================================
   食事記録 — Service Worker

   役割は3つ。
     1. アプリ本体を保存して、圏外でも開けるようにする
     2. 新しい版を出したら黙って入れ替える
     3. プッシュ通知を受け取る（VAPID設定後に有効）

   記録データそのものはここでは扱わない。送信できなかった記録は
   ページ側の localStorage キューが持っていて、オンライン復帰時に流す。
   ============================================================ */

const VERSION = 'v4';
const SHELL   = `nt-shell-${VERSION}`;   // 自分のファイル
const VENDOR  = `nt-vendor-${VERSION}`;  // esm.sh / Google Fonts

/* スコープ基準の相対パス。GitHub Pages のサブフォルダ配下でも動く */
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

/* 外部から取ってくるが、無いとアプリが起動しないもの */
const VENDOR_HOSTS = new Set([
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

// ------------------------------------------------------------
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // 1つでも失敗すると addAll は全部巻き戻る。個別に入れて取りこぼしを許す
    await Promise.all(SHELL_FILES.map(async (f) => {
      try { await c.add(new Request(f, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] precache skipped', f, err); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('nt-') && k !== SHELL && k !== VENDOR)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ------------------------------------------------------------
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Supabase への通信には触らない。
  // 認証やDB書き込みをキャッシュに混ぜると古い結果を掴んで事故る
  if (url.hostname.endsWith('.supabase.co')) return;

  // 画面遷移：まずネットワーク。新しい版があれば即反映され、
  // 圏外なら保存済みの本体を返す
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html'))
            ?? (await caches.match('./'))
            ?? Response.error();
      }
    })());
    return;
  }

  // 外部ライブラリ・フォント：あればキャッシュを返しつつ裏で更新
  if (VENDOR_HOSTS.has(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, VENDOR));
    return;
  }

  // 自分のファイル
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req, SHELL));
  }
});

async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const net = fetch(req).then((res) => {
    // opaque（status 0）は容量を食うだけで中身を確認できないので保存しない
    if (res && res.status === 200 && res.type !== 'opaque') c.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit ?? (await net) ?? Response.error();
}

// ------------------------------------------------------------
//  プッシュ通知（VAPIDキーを設定すると届くようになる）
// ------------------------------------------------------------
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { body: e.data?.text() ?? '' }; }

  e.waitUntil(self.registration.showNotification(p.title ?? '食事記録', {
    body: p.body ?? '',
    tag: p.tag ?? 'nt',
    renotify: false,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: p.url ?? './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url ?? './', self.location.origin + self.registration.scope).href;

  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 既に開いているタブがあれば、新しく開かずそれを前に出す
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope) && 'focus' in w) {
        if ('navigate' in w) { try { await w.navigate(target); } catch { /* noop */ } }
        return w.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
