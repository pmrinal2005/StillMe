/* StillMe (ReVOICE engine) offline shell.
 *  - Network-first for navigations, cache fallback. The cache is keyed PER PATH ('/', '/dashboard' and '/join'), so the partner page is
 *    available offline too (E50: it used to overwrite '/' with whichever page was visited last, and /join was never cached).
 *  - /_next/static/* is cache-first (content-hashed). Everything under /api/ is NEVER cached.
 *  - Offline navigation to an unknown path falls back to the app shell '/'; /join falls back to its own cached copy and then
 *    to a minimal offline page (the invite is in the URL fragment, which is never sent to the network anyway).
 */
const CACHE = 'stillme-shell-v4'
const SHELL = ['/', '/dashboard', '/join', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/favicon.ico', '/logo.svg']
const OFFLINE_JOIN = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StillMe offline</title><body style="font:16px system-ui;margin:2rem;max-width:32rem"><h1>You are offline</h1><p>Joining a conversation needs a connection. Reconnect and reload this page; your invitation link is still valid until it expires.</p></body>'

self.addEventListener('install', (e) => {
  // addAll is all-or-nothing: tolerate a single missing asset so install never fails the whole worker.
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => undefined)))).then(() => self.skipWaiting()),
  )
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

const pageKey = (url) => (url.pathname.startsWith('/join') ? '/join' : url.pathname.startsWith('/dashboard') ? '/dashboard' : '/')

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (e.request.mode === 'navigate') {
    const key = pageKey(url)
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone()
            caches.open(CACHE).then((c) => c.put(key, copy))
          }
          return r
        })
        .catch(async () => {
          const hit = await caches.match(key)
          if (hit) return hit
          if (key === '/join') return new Response(OFFLINE_JOIN, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
          // The working app shell is the dashboard; the landing page is only a fallback for the dashboard.
          return (await caches.match('/dashboard')) || (await caches.match('/')) || Response.error()
        }),
    )
    return
  }
  if (url.pathname.startsWith('/_next/static/') || SHELL.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((r) => {
            if (r.ok) {
              const copy = r.clone()
              caches.open(CACHE).then((c) => c.put(e.request, copy))
            }
            return r
          }),
      ),
    )
  }
})
