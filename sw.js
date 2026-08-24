// Görevler PWA - service worker
// Kod güncellenince sürümü artır: v2 -> v3 ...
const CACHE = "gorevler-v3";

const APP_SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./firebase-config.js",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
  "./apple-touch-icon.png", "./favicon-32.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firebase/Firestore ağ trafiğine dokunma (kendi çevrimdışı önbelleği var)
  if (url.hostname.includes("googleapis.com") || url.hostname.includes("firebaseio.com") ||
      url.hostname.includes("firebase") || url.hostname.includes("google.com")) {
    return;
  }

  // Aynı origin (uygulama dosyaları) + sayfa gezinmesi: ÖNCE AĞ, olmazsa önbellek.
  // Böylece her açılışta en güncel kod gelir; çevrimdışıysa önbellekten çalışır.
  if (req.mode === "navigate" || url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Dış kaynaklar (gstatic, cdnjs): önbellek öncelikli, arkada tazele.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
