/*
 * SAF Flow service worker. Makes the app installable and keeps it usable on a
 * shaky connection:
 *  - app code and static assets (/_next/static, icons): cache first, they are versioned;
 *  - pages: network first, falling back to the last copy, then to /offline.html;
 *  - /api and anything else: always the network. Business data is never cached.
 */
// One cache per deployed build (the page registers /sw.js?v=<build>). The
// previous build's cache is kept too, so a tab still running the old code can
// load its chunks until it refreshes; anything older is deleted.
const PREFIX = "saf-flow-v3-";
const VERSION = PREFIX + (new URL(self.location.href).searchParams.get("v") || "0");
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([OFFLINE, "/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      // caches.keys() lists caches in creation order: keep this build and the one before it.
      const builds = keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION);
      const keep = new Set([VERSION, builds[builds.length - 1]]);
      return Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    }).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match(OFFLINE))),
    );
  }
});
