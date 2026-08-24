// Görevler — bildirim gönderen zamanlanmış fonksiyon
// Her 5 dakikada bir çalışır; "saati gelen" ve henüz yapılmamış görevler için
// o görevin alanındaki üyelerin telefonlarına bildirim yollar.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

exports.sendReminders = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Europe/Istanbul", region: "europe-west1" },
  async () => {
    const now = Date.now();
    const windowStart = now - 30 * 60 * 1000; // son 30 dk (gecikmeleri de yakala)

    const snap = await db.collectionGroup("todos")
      .where("dueAt", ">", windowStart)
      .where("dueAt", "<=", now)
      .get();

    let sent = 0;
    for (const docSnap of snap.docs) {
      const t = docSnap.data();
      if (!t.dueAt || t.done) continue;           // yapılmışsa veya tarihsizse atla
      if (t.notifiedFor === t.dueAt) continue;     // bu occurrence için zaten gönderildi

      // Yol: spaces/{sid}/lists/{lid}/todos/{tid}
      const parts = docSnap.ref.path.split("/");
      const sid = parts[1], lid = parts[3];

      // Liste başlığı
      let listTitle = "Görevler";
      try {
        const l = await db.doc(`spaces/${sid}/lists/${lid}`).get();
        if (l.exists) {
          const ld = l.data();
          listTitle = (ld.emoji ? ld.emoji + " " : "") + (ld.title || "Görevler");
        }
      } catch (e) { /* yoksay */ }

      // Alan üyelerinin cihaz jetonları
      let tokens = [];
      try {
        const members = await db.collection(`spaces/${sid}/members`).get();
        for (const m of members.docs) {
          const u = await db.doc(`users/${m.id}`).get();
          const ts = u.exists ? u.data().fcmTokens : null;
          if (Array.isArray(ts)) tokens.push(...ts);
        }
      } catch (e) { /* yoksay */ }
      tokens = [...new Set(tokens)];

      if (tokens.length) {
        const body = t.text + (t.note ? " — " + t.note : "");
        try {
          await getMessaging().sendEachForMulticast({
            tokens,
            data: { title: listTitle, body, url: "./", tag: docSnap.id }
          });
          sent++;
        } catch (e) { console.error("gönderim hatası", e); }
      }

      await docSnap.ref.update({ notifiedFor: t.dueAt }).catch(() => {});
    }

    console.log(`Kontrol: ${snap.size} aday görev, ${sent} bildirim gönderildi.`);
  }
);
