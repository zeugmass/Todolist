// Görevler PWA - service worker
// Sürüm değişince eski önbellek temizlenir. Uygulamayı güncelleyince CACHE sürümünü artır.
const CACHE = "gorevler-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firebase/Firestore ağ isteklerine dokunma (kendi çevrimdışı önbelleği var)
  if (url.hostname.includes("googleapis.com") ||
      url.hostname.includes("firebaseio.com") ||
      url.hostname.includes("firebase") ||
      url.hostname.includes("google.com")) {
    return; // doğrudan ağa git
  }

  // Sayfa gezinmesi: önce ağ, olmazsa önbellekten index.html
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Diğer varlıklar (uygulama dosyaları + gstatic/cdnjs): önbellek öncelikli, arkada tazele
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && (url.origin === location.origin ||
            url.hostname.includes("gstatic.com") || url.hostname.includes("cloudflare.com"))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
