// Cache-first app shell, so the page keeps working with no internet once it has
// been loaded once. Bump CACHE when you change any of the files below.
// Keep this version in step with VERSION in version.js - test/version.test.mjs
// checks it. Reusing a cache name across releases leaves installed copies
// serving the previous build forever.
const CACHE = 'lora-chat-0.17.4';
const SHELL = [
  './',
  'index.html',
  'manual.html',
  'app.js',
  'version.js',
  'protocol.js',
  'transport.js',
  'position.js',
  'crypto.js',
  'history.js',
  'survey.js',
  'audio.js',
  'fragment.js',
  'media.js',
  'presence.js',
  'radar.js',
  'theme.js',
  'channel.js',
  'messaging.js',
  'outbox.js',
  'favicon.js',
  'vendor/qrcode.js',
  'backdrop.js',
  'vendor/three.module.min.js',
  'vendor/dotgothic16-latin.woff2',
  'manifest.webmanifest',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // ignoreSearch: the page asks for cache-busted URLs like favicon.svg?v=2,
  // which would otherwise miss the unversioned entry cached above and 404
  // offline.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
