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

const DAY = 86400000;
// Görevde saat dilimi (tz) yoksa varsayılan. Uygulama her görevin tz'sini yazıyor;
// bu yalnızca eski (tz'siz) görevler için. Kullanıcı Fransa'da olduğundan Europe/Paris.
const DEFAULT_TZ = "Europe/Paris";

// Bir UTC anının, verilen IANA saat diliminde tarih/saat parçaları (DST dahil, doğru).
function partsInTz(ms, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false
  });
  const m = {};
  for (const p of dtf.formatToParts(new Date(ms))) m[p.type] = p.value;
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let h = +m.hour; if (h === 24) h = 0; // bazı ortamlar 24 döndürür
  return { y: +m.year, mo: +m.month - 1, day: +m.day, h, mi: +m.minute, dow: dows[m.weekday] };
}
// Verilen saat diliminde yerel (y,mo,day,h,mi) zamanının UTC ms karşılığı (DST dahil).
function msInTz(y, mo, day, h, mi, tz) {
  const target = Date.UTC(y, mo, day, h, mi, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(guess, tz);
    const back = Date.UTC(p.y, p.mo, p.day, p.h, p.mi, 0);
    guess += target - back; // sapmayı düzelt
  }
  return guess;
}
// O saat diliminde "bugünün" 00:00'ı (UTC ms).
function startOfToday(now, tz) {
  const p = partsInTz(now, tz);
  return msInTz(p.y, p.mo, p.day, 0, 0, tz);
}

// Tekrarlayan görev için bugünün/en yakın gelecekteki occurrence'ı (görevin KENDİ tz'sine göre).
function nextOccurrence(t, startTodayMs, tz) {
  const bp = partsInTz(t.dueAt, tz);       // görevin saat-dakikası
  const sp = partsInTz(startTodayMs, tz);  // bugünün tarihi
  const h = bp.h, mi = bp.mi;
  if (t.repeat === "weekly" || t.repeat === "weekdays") {
    const days = (Array.isArray(t.weekdays) && t.weekdays.length) ? t.weekdays : [1, 2, 3, 4, 5];
    for (let i = 0; i <= 13; i++) {
      const cand = msInTz(sp.y, sp.mo, sp.day + i, h, mi, tz);
      const dow = partsInTz(cand, tz).dow;
      if (days.includes(dow)) return cand;
    }
    return startTodayMs;
  }
  if (t.repeat === "monthly") {
    const dd = Math.min(bp.day, 28);
    let cand = msInTz(sp.y, sp.mo, dd, h, mi, tz);
    if (cand < startTodayMs) cand = msInTz(sp.y, sp.mo + 1, dd, h, mi, tz);
    return cand;
  }
  // daily
  return msInTz(sp.y, sp.mo, sp.day, h, mi, tz);
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
    // Not: GÖNDERİM saat diliminden bağımsızdır (dueAt mutlak zaman). Saat dilimi
    // yalnız TEKRAR İLERLETME'de (gün dönümü) gerekir; o da görev bazında hesaplanır.

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
          // SADECE data gönderiyoruz; bildirimi service worker'daki onBackgroundMessage
          // GÖSTERİYOR (tek kaynak = tek bildirim). "notification"/"webpush.notification"
          // EKLEMEYİN: onları FCM ayrıca otomatik gösterir ve iPhone'da ÇİFT bildirim olur.
          // Urgency:high, iOS'un push'u geciktirmeden iletmesi için.
          const resp = await getMessaging().sendEachForMulticast({
            tokens,
            webpush: { headers: { Urgency: "high", TTL: "3600" } },
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

    // 2) TEKRAR İLERLETME — geçmiş güne kalmış tekrarlayanları bugüne al.
    // Her görev KENDİ saat dilimine (t.tz) göre değerlendirilir; "bugün"ün sınırı
    // görevi kuran kişinin bulunduğu yere göre belirlenir (Fransa, Türkiye, vb.).
    const rollSnap = await db.collectionGroup("todos")
      .where("dueAt", ">", now - 40 * DAY)
      .where("dueAt", "<", now)
      .get();

    let rolled = 0;
    for (const docSnap of rollSnap.docs) {
      const t = docSnap.data();
      if (!t.repeat || !t.dueAt) continue;
      const tz = t.tz || DEFAULT_TZ;
      const startTodayMs = startOfToday(now, tz);
      if (t.dueAt >= startTodayMs) continue; // bugün veya gelecek → dokunma
      const occ = nextOccurrence(t, startTodayMs, tz);
      if (occ && occ !== t.dueAt) {
        await docSnap.ref.update({ dueAt: occ, done: false }).catch(() => {});
        rolled++;
      }
    }

    console.log(`Gönderilen: ${sent}, ilerletilen: ${rolled}`);
  }
);
