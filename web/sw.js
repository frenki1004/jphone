// jPhone service worker: offline app shell. Only active over https
// (browsers do not register service workers on plain http, except localhost).
const VERSION = "jphone-v4";
const SHELL = ["./", "index.html", "styles.css", "app.js", "lib/reducer.js", "lib/connection.js", "lib/markdown.js", "lib/pairlink.js", "lib/scan.js", "lib/notify.js", "lib/lock.js", "lib/recent.js", "lib/images.js", "lib/changes.js", "lib/push.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates land immediately), cache as fallback when offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/push/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});

// Optional Web Push from the relay on the Mac (tools/push-relay.py). Same rules
// as pushNotice() in lib/push.js (kept in sync by test/push.test.js).
function pushNotice(data) {
  let d = data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      d = { body: d };
    }
  }
  d = d && typeof d === "object" ? d : {};
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  return { title: str(d.title, 120) || "jcode", body: str(d.body, 300), tag: str(d.tag, 120) || "jphone" };
}

self.addEventListener("push", (e) => {
  let text = "";
  try {
    text = e.data ? e.data.text() : "";
  } catch {
    /* undecryptable: still show something, browsers penalize silent pushes */
  }
  const n = pushNotice(text);
  // Always show one: Safari revokes push for pages that receive pushes silently.
  // The relay already skips pushes while jPhone is on screen (/push/seen).
  if (self.navigator.setAppBadge) self.navigator.setAppBadge(1).catch(() => {});
  e.waitUntil(self.registration.showNotification(n.title, { body: n.body, tag: n.tag, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: self.registration.scope } }));
});

// Tapping a turn notification brings jPhone to the front (or opens it).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.registration.scope));
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
