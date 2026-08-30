// FCM arka plan bildirim service worker'ı (uygulama kapalıyken bildirimi gösterir)
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDjMxKMX4sPdVqGqmUKFzNBOGs3DXVhZp8",
  authDomain: "todo-72119.firebaseapp.com",
  projectId: "todo-72119",
  storageBucket: "todo-72119.firebasestorage.app",
  messagingSenderId: "899072386998",
  appId: "1:899072386998:web:818683c7a623e0fcbc8317"
});

// Sunucu SADECE "data" gönderiyor (notification payload YOK) — bu yüzden bildirimi
// BURADA elle göstermek ZORUNLU. iOS'ta gösteren tek yer burasıdır; bu handler olmadan
// hiç bildirim çıkmaz. Tek kaynak olduğu için de çift bildirim olmaz.
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || "Görevler", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./" }
  });
});

// Bildirime tıklayınca uygulamayı aç
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  }));
});
