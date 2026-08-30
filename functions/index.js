// Görevler — bildirim + tekrar ilerletme (zamanlanmış fonksiyon)
// Her dakika çalışır:
//  1) Saati gelen ve yapılmamış görevler için alan üyelerine bildirim yollar.
//  2) Geçmiş güne kalmış tekrarlayan görevleri bugünün occurrence'ına ilerletir
//     (böylece uygulama hiç açılmasa da her gün/hafta hatırlatma gelir).

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

const OFFSET = 3 * 3600000; // Türkiye UTC+3 (yaz saati uygulanmıyor)
const DAY = 86400000;

function istParts(ms) {
  const d = new Date(ms + OFFSET);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function istMs(y, mo, day, h, mi) { return Date.UTC(y, mo, day, h, mi, 0, 0) - OFFSET; }

// Tekrarlayan görev için bugünün/en yakın gelecekteki occurrence'ı (İstanbul saatine göre)
function nextOccurrence(t, startTodayMs) {
  const bp = istParts(t.dueAt);        // görevin saat-dakikası
  const sp = istParts(startTodayMs);   // bugünün (h=0)
  const h = bp.h, mi = bp.mi;
  if (t.repeat === "weekly" || t.repeat === "weekdays") {
    const days = (Array.isArray(t.weekdays) && t.weekdays.length) ? t.weekdays : [1, 2, 3, 4, 5];
    for (let i = 0; i <= 13; i++) {
      const cand = istMs(sp.y, sp.mo, sp.day + i, h, mi);
      const dow = new Date(cand + OFFSET).getUTCDay();
      if (days.includes(dow)) return cand;
    }
    return startTodayMs;
  }
  if (t.repeat === "monthly") {
    const dd = Math.min(bp.day, 28);
    let cand = istMs(sp.y, sp.mo, dd, h, mi);
    if (cand < startTodayMs) cand = istMs(sp.y, sp.mo + 1, dd, h, mi);
    return cand;
  }
  // daily
  return istMs(sp.y, sp.mo, sp.day, h, mi);
}

async function tokensForSpace(sid) {
  const tokens = [];
  try {
    const members = await db.collection(`spaces/${sid}/members`).get();
    for (const m of members.docs) {
      const u = await db.doc(`users/${m.id}`).get();
      const ts = u.exists ? u.data().fcmTokens : null;
      if (Array.isArray(ts)) tokens.push(...ts);
    }
  } catch (e) { /* yoksay */ }
  return [...new Set(tokens)];
}

exports.sendReminders = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Europe/Istanbul", region: "europe-west1" },
  async () => {
    const now = Date.now();
    const sp = istParts(now);
    const startTodayMs = istMs(sp.y, sp.mo, sp.day, 0, 0);

    // 1) GÖNDERİM — saati gelenler
    const sendSnap = await db.collectionGroup("todos")
      .where("dueAt", ">", now - 30 * 60000)
      .where("dueAt", "<=", now)
      .get();

    let sent = 0;
    for (const docSnap of sendSnap.docs) {
      const t = docSnap.data();
      if (!t.dueAt || t.done) continue;
      if (t.notifiedFor === t.dueAt) continue;

      const parts = docSnap.ref.path.split("/"); // spaces/{sid}/lists/{lid}/todos/{tid}
      const sid = parts[1], lid = parts[3];

      let listTitle = "Görevler";
      try {
        const l = await db.doc(`spaces/${sid}/lists/${lid}`).get();
        if (l.exists) { const ld = l.data(); listTitle = (ld.emoji ? ld.emoji + " " : "") + (ld.title || "Görevler"); }
      } catch (e) { /* yoksay */ }

      const tokens = await tokensForSpace(sid);
      if (tokens.length) {
        const body = t.text + (t.note ? " — " + t.note : "");
        try {
          // iOS için: görünür "notification" + "webpush" şart. Sadece "data"
          // gönderilirse iPhone push'u sessiz sayıp GÖSTERMEZ.
          const resp = await getMessaging().sendEachForMulticast({
            tokens,
            notification: { title: listTitle, body },
            webpush: {
              headers: { Urgency: "high", TTL: "3600" },
              notification: { title: listTitle, body, icon: "icon-192.png", badge: "icon-192.png", tag: docSnap.id },
              fcmOptions: { link: "./" }
            },
            data: { title: listTitle, body, url: "./", tag: docSnap.id }
          });
          sent += resp.successCount;
          if (resp.failureCount) {
            resp.responses.forEach((r, i) => {
              if (!r.success) console.error("token gönderim hatası", tokens[i]?.slice(0, 12), r.error?.code);
            });
          }
        } catch (e) { console.error("gönderim hatası", e); }
      }
      await docSnap.ref.update({ notifiedFor: t.dueAt }).catch(() => {});
    }

    // 2) TEKRAR İLERLETME — geçmiş güne kalmış tekrarlayanları bugüne al
    const rollSnap = await db.collectionGroup("todos")
      .where("dueAt", ">", startTodayMs - 30 * DAY)
      .where("dueAt", "<", startTodayMs)
      .get();

    let rolled = 0;
    for (const docSnap of rollSnap.docs) {
      const t = docSnap.data();
      if (!t.repeat || !t.dueAt) continue;
      const occ = nextOccurrence(t, startTodayMs);
      if (occ && occ !== t.dueAt) {
        await docSnap.ref.update({ dueAt: occ, done: false }).catch(() => {});
        rolled++;
      }
    }

    console.log(`Gönderilen: ${sent}, ilerletilen: ${rolled}`);
  }
);
