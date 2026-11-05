const C = "tsm-v10";
const A = ["./", "./index.html", "./app.html", "./download.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(A)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((k) => Promise.all(k.filter((x) => x !== C && !x.startsWith("tsm-bundle-")).map((x) => caches.delete(x)))).then(() => clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/.netlify/") || u.origin !== location.origin) return;
  // Сначала — файлы установленного обновления (загруженный zip), затем сеть с офлайн-кэшем
  e.respondWith(
    fromBundle(e.request).then((hit) =>
      hit ||
      fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const c = r.clone();
            caches.open(C).then((x) => x.put(e.request, c));
          }
          return r;
        })
        .catch(() => caches.match(e.request))
    )
  );
});

async function fromBundle(req) {
  for (const k of await caches.keys()) {
    if (!k.startsWith("tsm-bundle-")) continue;
    const m = await (await caches.open(k)).match(req.url);
    if (m) return m;
  }
  return null;
}

// Push: показываем уведомление, даже когда приложение закрыто.
// Если окно приложения открыто и видно, уведомление не дублируем.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(
    (async () => {
      const l = await clients.matchAll({ type: "window", includeUncontrolled: true });
      if (l.some((c) => c.visibilityState === "visible")) return;
      await self.registration.showNotification(d.title || "TSMESEDJER", {
        body: d.body || "Новое сообщение",
        icon: "icon-192.png",
        badge: "icon-192.png",
        tag: d.tag || "tsm",
        renotify: true,
        data: { url: "app.html" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const l = await clients.matchAll({ type: "window", includeUncontrolled: true });
      if (l.length) return l[0].focus();
      return clients.openWindow("app.html");
    })()
  );
});
