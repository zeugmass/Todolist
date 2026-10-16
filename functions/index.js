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
// bu yalnızca eski (tz'siz) görevler için.
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

// ── Takviye / ilaç ──────────────────────────────────────────────────────────
// Belge: günde 1–4 saat (times; eski sürüm 12 belgelerinde yalnız time), dozların verilme bilgisi
// (doses["SS:DD"].at; eski belgede lastGivenAt), isteğe bağlı kür (startDate–endDate, takviyenin tz'sinde).
const HOUR_MS = 3600000;
function medTimes(m) { return (Array.isArray(m.times) && m.times.length ? m.times : [m.time || "09:00"]).slice().sort(); }
function ymdInTz(ms, tz) { const p = partsInTz(ms, tz); return `${p.y}-${String(p.mo + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; }
function doseGivenAt(m, t) {
  if (m.doses) return (m.doses[t] && m.doses[t].at) || 0;
  return t === medTimes(m)[0] ? (m.lastGivenAt || 0) : 0; // sürüm 12 belgesi
}
// "after"dan SONRAKİ ilk doz (kür aralığında) → { at, dose } ya da kür bittiyse null
function nextDoseAt(m, after) {
  const tz = m.tz || DEFAULT_TZ, times = medTimes(m), p = partsInTz(after, tz);
  for (let d = 0; d <= 2; d++) {
    for (const t of times) {
      const [h, mi] = t.split(":").map((x) => parseInt(x, 10));
      const at = msInTz(p.y, p.mo, p.day + d, h, mi, tz);
      if (at <= after) continue;
      const day = ymdInTz(at, tz);
      if (m.startDate && day < m.startDate) continue;
      if (m.endDate && day > m.endDate) return null;
      return { at, dose: t };
    }
  }
  return null;
}
// Hatırlatmanın bir adımı: belge + şimdi → { upd: yazılacak alanlar, send: bildirim?, dose: hangi doz }
// "Verildi mi" o dozun İLK hatırlatmasının gününün başından beri bakılır (23:30 dozunun 00:30'daki
// 2. hatırlatması da doğru güne göre karar verir). 2. hatırlatma 1 saat sonra; ama sonraki doz o
// 1 saat içindeyse tekrar yerine doğrudan sonraki doza geçilir (doz atlanmasın).
function medStep(m, now) {
  const tz = m.tz || DEFAULT_TZ;
  const dose = m.notifyDose || medTimes(m)[0];
  const firstAt = m.notifyAt - (m.remindN ? HOUR_MS : 0);
  const given = doseGivenAt(m, dose) >= startOfToday(firstAt, tz);
  const stale = now - m.notifyAt > 30 * 60000; // sunucu kaçırmış/eski → göndermeden ileri al
  const nd = nextDoseAt(m, now);
  const next = nd ? { notifyAt: nd.at, notifyDose: nd.dose, remindN: 0 } : { notifyAt: null, notifyDose: null, remindN: 0 };
  if (given || stale) return { upd: next, send: false, dose };
  if (!m.remindN) {
    const repeat = m.notifyAt + HOUR_MS;
    if (nd && nd.at <= repeat) return { upd: next, send: true, dose };
    return { upd: { notifyAt: repeat, notifyDose: dose, remindN: 1 }, send: true, dose };
  }
  return { upd: next, send: true, dose };
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
    // görevi kuran kişinin bulunduğu yere göre belirlenir.
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

    // 3) BEBEK BESLENME HATIRLATMASI — uygulama bebek belgesine nextFeedAt (= son beslenme +
    //    3/4 saat) yazar. Emzirme sürüyorsa gönderilmez. Kilit ekranında ad/miktar YOK (gizlilik).
    // Ayrı try: bu bölüm (ör. dizin henüz hazır değilse) hata verse bile görev hatırlatmaları etkilenmez.
    let feedSent = 0;
    try {
    const feedSnap = await db.collectionGroup("babies")
      .where("nextFeedAt", ">", now - 30 * 60000)
      .where("nextFeedAt", "<=", now)
      .get();
    for (const bSnap of feedSnap.docs) {
      const b = bSnap.data();
      if (!b.nextFeedAt || b.nextFeedNotifiedFor === b.nextFeedAt) continue;
      if (b.activeTimer) continue; // şu an emziriliyor; bitince yeni zaman kurulur
      const sid = bSnap.ref.path.split("/")[1]; // spaces/{sid}/babies/{bid}
      const tokens = await tokensForSpace(sid);
      if (tokens.length) {
        const p = b.lastFeedAt ? partsInTz(b.lastFeedAt, b.tz || DEFAULT_TZ) : null;
        const hours = b.feedReminderHours || 3;
        const body = p
          ? `Son beslenme ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")} (${String(hours).replace(".", ",")} saat önce)`
          : "Beslenme zamanı geldi";
        try {
          const resp = await getMessaging().sendEachForMulticast({
            tokens,
            webpush: { headers: { Urgency: "high", TTL: "3600" } },
            data: { title: "🍼 Beslenme zamanı", body, url: "./", tag: "feed-" + bSnap.id }
          });
          feedSent += resp.successCount;
        } catch (e) { console.error("beslenme bildirimi hatası", e); }
      }
      await bSnap.ref.update({ nextFeedNotifiedFor: b.nextFeedAt }).catch(() => {});
    }
    } catch (e) { console.error("beslenme hatırlatma adımı hatası", e.message || e); }

    // 4) VİTAMİN / İLAÇ HATIRLATMASI — her takviye belgesinde notifyAt (sıradaki hatırlatma anı) var.
    //    Saatinde verilmemişse bildirim; 1 saat sonra hâlâ işaretlenmemişse BİR kez daha; sonra ertesi güne.
    //    O gün (takviyenin tz'sine göre) zaten verildiyse göndermeden ertesi güne kurulur.
    //    Önce notifyAt ilerletilir, sonra gönderilir → aynı hatırlatma iki kez gitmez.
    let medSent = 0;
    try {
    const medSnap = await db.collectionGroup("meds").where("notifyAt", "<=", now).get();
    for (const mSnap of medSnap.docs) {
      const m = mSnap.data();
      const { upd, send, dose } = medStep(m, now);
      try { await mSnap.ref.update(upd); } catch (e) { continue; }
      if (!send) continue;
      const sid = mSnap.ref.path.split("/")[1]; // spaces/{sid}/babies/{bid}/meds/{mid}
      const tokens = await tokensForSpace(sid);
      if (!tokens.length) continue;
      try {
        const resp = await getMessaging().sendEachForMulticast({
          tokens,
          webpush: { headers: { Urgency: "high", TTL: "3600" } },
          data: {
            title: "💊 Takviye zamanı",
            body: (medTimes(m).length > 1 ? `${m.name} (${dose}) — henüz işaretlenmedi` : `${m.name} — bugün henüz işaretlenmedi`)
              + (m.remindN ? " (2. hatırlatma)" : ""),
            url: "./", tag: "med-" + mSnap.id
          }
        });
        medSent += resp.successCount;
      } catch (e) { console.error("takviye bildirimi hatası", e); }
    }
    } catch (e) { console.error("takviye hatırlatma adımı hatası", e.message || e); }

    console.log(`Gönderilen: ${sent}, ilerletilen: ${rolled}, beslenme: ${feedSent}, takviye: ${medSent}`);
  }
);
