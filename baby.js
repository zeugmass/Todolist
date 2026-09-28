// ============================================================================
// BEBEK TAKİBİ — Faz 1: beslenme (biberon + emzirme sayacı + hatırlatma)
// app.js'ten createBabyTracker(ctx) ile kurulur.
// Veri: spaces/{sid}/babies/{bid}  ve  spaces/{sid}/babies/{bid}/events/{eid}
// GÜVENLİK: kullanıcı verisi (ad, not, e-posta) ASLA innerHTML'e yazılmaz;
// yalnız textContent/value kullanılır. Kurallar: firestore.rules (validBaby/validFeed).
// ============================================================================
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, getDocs,
  query, where, orderBy, limit, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const ML_CHIPS = [60, 90, 120, 150, 180];
const DUR_CHIPS = [5, 10, 15, 20, 30];
const MILK = { breast: "Anne sütü", formula: "Mama" };
const SIDE = { L: "Sol", R: "Sağ", both: "İki taraf" };
const REMIND_OPTS = [[0, "Kapalı"], [3, "3 saat"], [3.5, "3,5 saat"], [4, "4 saat"]]; // kurallarla aynı
const fmtH = (h) => String(h).replace(".", ","); // 3.5 → "3,5"
const MAX_BREAST_MS = 6 * HOUR;   // kurallarla aynı üst sınır
const MAX_SLEEP_MS = 16 * HOUR;   // kurallarla aynı üst sınır
const WHEN_HTML = `<div class="bb-seg" id="f-when"><button type="button" data-m="0">Şimdi</button><button type="button" data-m="15">15 dk önce</button><button type="button" data-m="30">30 dk önce</button></div>`;
const SLEEP_CHIPS = [[30, "30 dk"], [60, "1 sa"], [90, "1,5 sa"], [120, "2 sa"], [180, "3 sa"]];
const FUTURE_SLACK = 5 * MIN;     // saat farkları için küçük tolerans

/* ---------- zaman yardımcıları (cihazın yerel saatiyle) ---------- */
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function atFromDayAndTime(dayMs, timeStr) {
  const [h, m] = String(timeStr || "").split(":").map((x) => parseInt(x, 10));
  if (!Number.isInteger(h) || !Number.isInteger(m)) return NaN;
  const d = new Date(dayMs); d.setHours(h, m, 0, 0); return d.getTime();
}
function durText(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 1) return "<1 dk";
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} sa ${r} dk` : `${h} sa`;
}
function agoText(ms) {
  const diff = Date.now() - ms;
  if (diff < MIN) return "az önce";
  if (diff < DAY) return `${durText(diff)} önce`;
  return `${Math.floor(diff / DAY)} gün önce`;
}
function clock(ms) { // sayaç görünümü: 12:34 ya da 1:02:03
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
}
function dayLabel(dayMs) {
  const today = startOfDay(Date.now());
  if (dayMs === today) return "Bugün";
  if (dayMs === addDays(today, -1)) return "Dün";
  return new Date(dayMs).toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "short" });
}
function ageText(birthDate) {
  if (!birthDate) return "";
  const b = new Date(birthDate + "T00:00:00").getTime();
  if (!Number.isFinite(b)) return "";
  const days = Math.round((startOfDay(Date.now()) - b) / DAY);
  if (days < 0) return "";
  if (days < 14) return `${days} günlük`;
  if (days < 60) return `${Math.floor(days / 7)} haftalık`;
  return `${Math.floor(days / 30.44)} aylık`;
}
function feedText(ev) {
  if (ev.method === "bottle") return `🍼 ${ev.ml} ml` + (ev.milk && MILK[ev.milk] ? ` · ${MILK[ev.milk]}` : "");
  return `🤱 ${SIDE[ev.side] || ""} · ${durText((ev.endAt || ev.at) - ev.at)}`;
}
function diaperText(ev) {
  return "🧷 " + (ev.pee && ev.poo ? "Islak + kirli" : ev.poo ? "Kirli" : "Islak");
}
const fmtG = (g) => `${Number(g).toLocaleString("tr-TR")} g`;                                  // 3650 → "3.650 g"
const fmtCm = (mm) => `${(mm / 10).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} cm`;   // 525 → "52,5 cm"
function growthText(ev) {
  const p = [];
  if (ev.weightG != null) p.push(fmtG(ev.weightG));
  if (ev.lengthMm != null) p.push(fmtCm(ev.lengthMm));
  if (ev.headMm != null) p.push(`baş ${fmtCm(ev.headMm)}`);
  return p.join(" · ");
}
function evText(ev) {
  if (ev.type === "diaper") return diaperText(ev);
  if (ev.type === "sleep") return `😴 Uyku · ${durText((ev.endAt || ev.at) - ev.at)}`;
  if (ev.type === "growth") return `📏 ${growthText(ev)}`;
  if (ev.type === "med") return `💊 ${ev.name} verildi`;
  return feedText(ev);
}
const MED_IDS = ["m1", "m2", "m3", "m4", "m5"]; // kurallarla aynı: en fazla 5 takviye
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// "52,5" / "52.5" → 525 (mm); boş → null; geçersiz → NaN
function parseCmToMm(v) {
  const s = String(v || "").trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 10) : NaN;
}

/* ---------- grafikler (kütüphanesiz SVG; veri yalnız sayı/textContent) ---------- */
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}
// "Güzel" üst sınır: 1-2-5 × 10^n
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
// Üstü 4px yuvarlak, tabana oturan çubuk yolu
function barPath(x, y, w, base, r) {
  const h = base - y;
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${base}Z`;
}

/* Tek seri çubuk grafik: 7 gün. Değer her çubukta yazılmaz; dokununca okuma satırında görünür. */
function barChart({ title, unitFmt, values, labels, fullLabels, todayIdx }) {
  const box = el("div", "ch");
  const sum = values.reduce((a, b) => a + b, 0);
  const daysWithData = values.filter((v) => v > 0).length || 1;
  const head = el("div", "ch-head");
  head.append(el("span", "ch-title", title),
    el("span", "ch-meta", `ort. ${unitFmt(sum / daysWithData)} · bugün ${unitFmt(values[todayIdx] || 0)}`));
  box.append(head);
  const W = 300, H = 118, base = 96, top = 14, n = values.length, slot = W / n, bw = Math.min(28, slot - 10);
  const max = niceMax(Math.max(...values));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch-svg", role: "img",
    "aria-label": `${title}: ` + values.map((v, i) => `${fullLabels[i]} ${unitFmt(v)}`).join(", ") });
  svg.append(svgEl("line", { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, class: "ch-grid" }));
  svg.append(svgEl("line", { x1: 0, x2: W, y1: top + 0.5, y2: top + 0.5, class: "ch-grid faint" }));
  svg.append(svgEl("text", { x: 2, y: top - 4, class: "ch-axis" }, unitFmt(max)));
  const readout = el("div", "ch-readout", "Bir güne dokun, değeri görünsün.");
  readout.setAttribute("aria-live", "polite");
  const bars = [];
  values.forEach((v, i) => {
    const x = i * slot + (slot - bw) / 2;
    const y = base - (v / max) * (base - top);
    const bar = svgEl("path", { d: barPath(x, y, bw, base, 4), class: "ch-bar" });
    bars.push(bar);
    svg.append(bar);
    svg.append(svgEl("text", { x: i * slot + slot / 2, y: H - 6, "text-anchor": "middle",
      class: "ch-axis" + (i === todayIdx ? " strong" : "") }, labels[i]));
    const hit = svgEl("rect", { x: i * slot, y: 0, width: slot, height: H, class: "ch-hit" });
    hit.addEventListener("click", () => {
      bars.forEach((b, j) => b.classList.toggle("dim", j !== i));
      readout.textContent = `${fullLabels[i]}: ${unitFmt(v)}`;
    });
    svg.append(hit);
  });
  box.append(svg, readout);
  return box;
}

/* Tek seri çizgi grafik (gelişim). Son noktada doğrudan etiket; dokununca okuma satırı. */
function lineChart({ points, valFmt, dateFmt }) {
  const box = el("div", "ch");
  if (!points.length) { box.append(el("p", "muted ch-empty", "Henüz bu ölçüm yok.")); return box; }
  const W = 300, H = 150, L = 8, R = 44, T = 16, B = 22;
  const xs = points.map((p) => p.at), ys = points.map((p) => p.v);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= DAY; x1 += DAY; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max((y1 - y0) * 0.15, y1 * 0.02, 1); y0 -= pad; y1 += pad;
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch-svg", role: "img",
    "aria-label": points.map((p) => `${dateFmt(p.at)} ${valFmt(p.v)}`).join(", ") });
  svg.append(svgEl("line", { x1: L, x2: W - R, y1: H - B + 0.5, y2: H - B + 0.5, class: "ch-grid" }));
  svg.append(svgEl("text", { x: L, y: H - 6, class: "ch-axis" }, dateFmt(points[0].at)));
  if (points.length > 1) svg.append(svgEl("text", { x: W - R, y: H - 6, "text-anchor": "end", class: "ch-axis" }, dateFmt(points[points.length - 1].at)));
  if (points.length > 1) svg.append(svgEl("polyline", { points: points.map((p) => `${X(p.at)},${Y(p.v)}`).join(" "), class: "ch-line" }));
  const readout = el("div", "ch-readout", points.length > 1 ? "Bir noktaya dokun, değeri görünsün." : "");
  readout.setAttribute("aria-live", "polite");
  const dots = [];
  points.forEach((p, i) => {
    const dot = svgEl("circle", { cx: X(p.at), cy: Y(p.v), r: 4.5, class: "ch-dot" });
    dots.push(dot); svg.append(dot);
    const hit = svgEl("circle", { cx: X(p.at), cy: Y(p.v), r: 16, class: "ch-hit" });
    hit.addEventListener("click", () => {
      dots.forEach((d, j) => d.classList.toggle("sel", j === i));
      readout.textContent = `${dateFmt(p.at)}: ${valFmt(p.v)}`;
    });
    svg.append(hit);
  });
  const last = points[points.length - 1];
  svg.append(svgEl("text", { x: X(last.at) + 8, y: Y(last.v) + 4, class: "ch-label" }, valFmt(last.v)));
  box.append(svg, readout);
  return box;
}

/* ---------- güvenli DOM yardımcıları ---------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(cls, text, onClick) {
  const b = el("button", cls, text);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
// data-v taşıyan butonlardan oluşan seçim grubu; allowNone: seçiliye tekrar basınca kaldırır
function wireSeg(box, current, onChange, allowNone = false) {
  const btns = [...box.querySelectorAll("button[data-v]")];
  const paint = (v) => btns.forEach((b) => b.classList.toggle("sel", b.dataset.v === String(v)));
  paint(current);
  btns.forEach((b) => b.addEventListener("click", () => {
    const v = allowNone && b.classList.contains("sel") ? null : b.dataset.v;
    paint(v); onChange(v);
  }));
  return paint;
}

export function createBabyTracker(ctx) {
  const { db, getUser, $, toast, showSnackbar, openModal, closeModal, modalError, dbg, personColor, onTitleChange } = ctx;
  const TZ = ctx.TZ || "";
  const root = $("baby-view");

  let sid = null, bid = null, baby = null;
  let babiesUnsub = null, lastUnsub = null, dayUnsub = null, membersUnsub = null;
  let lastDiaperUnsub = null, lastSleepUnsub = null, medsUnsub = null;
  let meds = []; // günlük takviyeler (D vitamini vb.), saate göre sıralı
  let lastFeed = null, lastLoaded = false, lastDiaper = null, lastSleep = null, dayEvents = [];
  let dayStart = startOfDay(Date.now()), followToday = true;
  const members = new Map(); // uid -> e-posta (baş harf için)
  let ticker = null, tickCount = 0;

  const uid = () => getUser()?.uid;
  const babyRef = () => doc(db, "spaces", sid, "babies", bid);
  const evCol = () => collection(db, "spaces", sid, "babies", bid, "events");
  const evRef = (id) => doc(db, "spaces", sid, "babies", bid, "events", id);
  const medRef = (id) => doc(db, "spaces", sid, "babies", bid, "meds", id);
  const initial = (u) => ((members.get(u) || "?").trim()[0] || "?").toUpperCase();
  const fail = (what) => (e) => { dbg(`${what} HATA: ${e.code || e.message}`); toast(`⚠️ ${what} kaydedilemedi`); };

  /* ================= yaşam döngüsü ================= */
  function start(spaceId) {
    if (sid === spaceId && babiesUnsub) { render(); return; }
    stop();
    sid = spaceId;
    dayStart = startOfDay(Date.now()); followToday = true;
    root.dataset.mode = "";
    root.replaceChildren(el("p", "muted bb-loading", "Yükleniyor…"));

    babiesUnsub = onSnapshot(query(collection(db, "spaces", sid, "babies"), orderBy("createdAt")), (snap) => {
      if (snap.empty) { stopEvents(); bid = null; baby = null; render(); onTitleChange(); return; }
      const d = snap.docs[0];
      if (d.id !== bid) { stopEvents(); bid = d.id; baby = d.data(); startEvents(); }
      else baby = d.data();
      syncNextFeed(); render(); onTitleChange();
    }, (e) => {
      dbg("bebek HATA: " + (e.code || e.message));
      root.dataset.mode = "";
      root.replaceChildren(el("p", "muted bb-loading", "Bebek verisi yüklenemedi. Üstteki yenile düğmesine bas."));
    });

    membersUnsub = onSnapshot(collection(db, "spaces", sid, "members"), (snap) => {
      members.clear(); snap.forEach((m) => members.set(m.id, m.data().email || ""));
      render();
    }, () => {});

    ticker = setInterval(updateLive, 1000);
  }

  // Türe göre en son kayıt. Canlıda bileşik dizin gerekir: events (type ↑, at ↓) — firestore.indexes.json
  const lastOf = (type) => query(evCol(), where("type", "==", type), orderBy("at", "desc"), limit(1));
  const firstDoc = (snap) => (snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() });
  function startEvents() {
    lastLoaded = false;
    lastDiaperUnsub = onSnapshot(lastOf("diaper"), (s) => { lastDiaper = firstDoc(s); render(); },
      (e) => dbg("son bez HATA: " + (e.code || e.message)));
    lastSleepUnsub = onSnapshot(lastOf("sleep"), (s) => { lastSleep = firstDoc(s); render(); },
      (e) => dbg("son uyku HATA: " + (e.code || e.message)));
    lastUnsub = onSnapshot(lastOf("feed"), (snap) => {
      lastFeed = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
      lastLoaded = true;
      syncNextFeed(); render();
    }, (e) => dbg("son beslenme HATA: " + (e.code || e.message)));
    medsUnsub = onSnapshot(collection(db, "spaces", sid, "babies", bid, "meds"), (s) => {
      meds = s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.time || "").localeCompare(b.time || "") || a.id.localeCompare(b.id));
      render();
    }, (e) => dbg("takviyeler HATA: " + (e.code || e.message)));
    subscribeDay();
  }

  function subscribeDay() {
    if (dayUnsub) { dayUnsub(); dayUnsub = null; }
    dayEvents = [];
    if (!bid) return;
    const q = query(evCol(), where("at", ">=", dayStart), where("at", "<", addDays(dayStart, 1)), orderBy("at", "desc"));
    dayUnsub = onSnapshot(q, (snap) => {
      dayEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, (e) => dbg("gün kayıtları HATA: " + (e.code || e.message)));
  }

  function stopEvents() {
    if (lastUnsub) { lastUnsub(); lastUnsub = null; }
    if (dayUnsub) { dayUnsub(); dayUnsub = null; }
    if (lastDiaperUnsub) { lastDiaperUnsub(); lastDiaperUnsub = null; }
    if (lastSleepUnsub) { lastSleepUnsub(); lastSleepUnsub = null; }
    if (medsUnsub) { medsUnsub(); medsUnsub = null; }
    lastFeed = null; lastLoaded = false; lastDiaper = null; lastSleep = null; dayEvents = []; meds = [];
  }

  function stop() {
    if (babiesUnsub) { babiesUnsub(); babiesUnsub = null; }
    if (membersUnsub) { membersUnsub(); membersUnsub = null; }
    stopEvents();
    clearInterval(ticker); ticker = null;
    sid = null; bid = null; baby = null; members.clear();
  }

  function resync() { const s = sid; stop(); if (s) start(s); }

  // Hatırlatma zamanını SON beslenmeden türet ve bebek belgesine yaz; sunucu bunu okuyup
  // bildirim gönderir. İki telefon da aynı değeri hesaplar; değer zaten eşitse yazmaz (döngü yok).
  function syncNextFeed() {
    if (!baby || !bid || !lastLoaded) return;
    const hours = baby.feedReminderHours || 0;
    const lastAt = lastFeed ? lastFeed.at : null;
    const next = hours && lastAt ? lastAt + hours * HOUR : null;
    if ((baby.lastFeedAt ?? null) === lastAt && (baby.nextFeedAt ?? null) === next && baby.tz === TZ) return;
    updateDoc(babyRef(), { lastFeedAt: lastAt, nextFeedAt: next, tz: TZ })
      .catch((e) => dbg("hatırlatma HATA: " + (e.code || e.message)));
  }

  // Her saniye: "… önce" metni, sayaç, gece yarısı gün geçişi
  function updateLive() {
    if (!sid || !baby) return;
    if (followToday && startOfDay(Date.now()) !== dayStart) {
      dayStart = startOfDay(Date.now()); subscribeDay(); render(); return;
    }
    const ago = document.getElementById("bb-ago");
    if (ago && lastFeed) ago.textContent = agoText(lastFeed.at);
    const tm = document.getElementById("bb-timer");
    if (tm && baby.activeTimer) tm.textContent = clock(Date.now() - baby.activeTimer.startedAt);
    const st = document.getElementById("bb-stimer");
    if (st && baby.sleepTimer) st.textContent = clock(Date.now() - baby.sleepTimer.startedAt);
    // "son bez … önce / uyanık …" kutucukları için 30 sn'de bir yeniden çiz (pencere açıkken değil)
    if (++tickCount % 30 === 0 && $("modal-overlay").classList.contains("hidden")) render();
  }

  /* ================= çizim ================= */
  function render() {
    if (!sid) return;
    if (!bid) { renderSetup(); return; }
    if (!baby) return;
    root.dataset.mode = "main";
    const frag = document.createDocumentFragment();
    frag.append(summaryCard());
    if (baby.activeTimer) frag.append(timerCard());
    if (baby.sleepTimer) frag.append(sleepCard());
    frag.append(actionsRow());
    if (meds.length) frag.append(medsCard());
    frag.append(linksRow(), dayNav(), timeline());
    root.replaceChildren(frag);
  }

  // Gün özeti. Uyku, BAŞLADIĞI güne yazılır (gece yarısını geçen uyku, başladığı günde sayılır).
  function dayTotals() {
    const t = { count: 0, bottles: 0, breasts: 0, ml: 0, breastMs: 0, diapers: 0, pee: 0, poo: 0, sleepMs: 0 };
    for (const ev of dayEvents) {
      if (ev.type === "diaper") { t.diapers++; if (ev.pee) t.pee++; if (ev.poo) t.poo++; continue; }
      if (ev.type === "sleep") { t.sleepMs += Math.max(0, (ev.endAt || ev.at) - ev.at); continue; }
      if (ev.type === "growth" || ev.type === "med") continue; // ölçüm / takviye; beslenme sayılmaz
      t.count++;
      if (ev.method === "bottle") { t.bottles++; t.ml += ev.ml || 0; }
      else { t.breasts++; t.breastMs += Math.max(0, (ev.endAt || ev.at) - ev.at); }
    }
    return t;
  }

  function reminderText() {
    const h = baby.feedReminderHours || 0;
    if (!h) return "⏰ Hatırlatma kapalı — açmak için dokun";
    if (baby.activeTimer) return `⏰ Emzirme bitince ${fmtH(h)} saatlik hatırlatma kurulur`;
    if (!lastFeed) return `⏰ Hatırlatma: ilk beslenmeden ${fmtH(h)} saat sonra`;
    const next = lastFeed.at + h * HOUR;
    return next > Date.now() ? `⏰ Sonraki hatırlatma ${hhmm(next)} (${fmtH(h)} saat)` : `⏰ Beslenme zamanı geçti (${hhmm(next)})`;
  }

  function summaryCard() {
    const c = el("section", "bb-card");
    const top = el("div", "bb-row");
    top.append(el("span", "bb-label", "Son beslenme"));
    const age = ageText(baby.birthDate);
    if (age) top.append(el("span", "bb-age", age));
    c.append(top);
    if (lastFeed) {
      const big = el("div", "bb-big", agoText(lastFeed.at)); big.id = "bb-ago";
      const who = members.size > 1 && lastFeed.by ? ` · ${initial(lastFeed.by)}` : "";
      c.append(big, el("div", "bb-sub", `${feedText(lastFeed)} · ${hhmm(lastFeed.at)}${who}`));
    } else {
      c.append(el("div", "bb-big", "—"), el("div", "bb-sub", "Henüz beslenme kaydı yok"));
    }
    c.append(el("div", "bb-sep"));
    const tot = dayTotals();
    const row = el("div", "bb-row");
    row.append(el("span", "bb-label", dayLabel(dayStart)), el("span", "bb-total", `${tot.ml} ml`));
    c.append(row);
    c.append(el("div", "bb-sub", tot.count
      ? `${tot.count} beslenme · 🍼 ${tot.bottles} · 🤱 ${tot.breasts}${tot.breastMs ? ` (${durText(tot.breastMs)})` : ""}`
      : "Bu gün beslenme yok"));
    c.append(tilesRow(tot));
    c.append(btn("bb-remind", reminderText(), openSettings));
    return c;
  }

  // Bez ve uyku kutucukları (seçili günün toplamı + "son / uyanık" bilgisi)
  function tilesRow(tot) {
    const row = el("div", "bb-tiles");
    const d = el("div", "bb-tile");
    const dSub = (tot.diapers ? `💧${tot.pee} · 💩${tot.poo}` : "—")
      + (lastDiaper && Date.now() - lastDiaper.at < DAY ? ` · son ${agoText(lastDiaper.at)}` : "");
    d.append(el("div", "bb-tile-label", "🧷 Bez"), el("div", "bb-tile-val", String(tot.diapers)), el("div", "bb-tile-sub", dSub));
    const s = el("div", "bb-tile");
    const awake = baby.sleepTimer ? "şu an uyuyor"
      : lastSleep && lastSleep.endAt && Date.now() - lastSleep.endAt < DAY ? `uyanık ${durText(Date.now() - lastSleep.endAt)}` : "—";
    s.append(el("div", "bb-tile-label", "😴 Uyku"), el("div", "bb-tile-val", tot.sleepMs ? durText(tot.sleepMs) : "0 dk"), el("div", "bb-tile-sub", awake));
    row.append(d, s);
    return row;
  }

  function timerCard() {
    const t = baby.activeTimer;
    const c = el("section", "bb-card bb-timer");
    const by = t.startedBy && t.startedBy !== uid() && members.size > 1 ? ` · ${initial(t.startedBy)} başlattı` : "";
    c.append(el("div", "bb-label", `🤱 Emziriliyor · ${SIDE[t.side] || ""}${by}`));
    const big = el("div", "bb-big bb-clock", clock(Date.now() - t.startedAt)); big.id = "bb-timer";
    c.append(big);
    const acts = el("div", "bb-timer-actions");
    const other = t.side === "L" ? "R" : "L";
    acts.append(btn("btn-secondary", `${SIDE[other]} tarafa geç`, timerSwitch), btn("btn-primary", "Bitir", timerFinish));
    c.append(acts, btn("link-btn danger bb-cancel", "Sayacı iptal et", timerCancel));
    return c;
  }

  function actionsRow() {
    const r = el("div", "bb-actions");
    r.append(btn("bb-action", "🍼 Biberon", () => openBottle()));
    if (!baby.activeTimer) r.append(btn("bb-action", "🤱 Emzirme", () => openBreast()));
    r.append(btn("bb-action", "🧷 Bez", () => openDiaper()));
    if (!baby.sleepTimer) r.append(btn("bb-action", "😴 Uyku", () => openSleep()));
    return r;
  }

  function goDay(ms) {
    dayStart = startOfDay(ms);
    followToday = dayStart === startOfDay(Date.now());
    subscribeDay(); render();
  }
  function dayNav() {
    const n = el("div", "bb-daynav");
    const isToday = dayStart >= startOfDay(Date.now());
    const prev = btn("icon-btn", "‹", () => goDay(addDays(dayStart, -1)));
    prev.setAttribute("aria-label", "Önceki gün");
    const lab = btn("bb-daylabel", dayLabel(dayStart), () => { if (!isToday) goDay(Date.now()); });
    const next = btn("icon-btn", "›", () => { if (!isToday) goDay(addDays(dayStart, 1)); });
    next.setAttribute("aria-label", "Sonraki gün"); next.disabled = isToday;
    n.append(prev, lab, next);
    return n;
  }

  function timeline() {
    const ul = el("ul", "bb-list");
    if (!dayEvents.length) { ul.append(el("li", "bb-empty muted", "Bu gün için kayıt yok.")); return ul; }
    for (const ev of dayEvents) {
      const li = el("li", "bb-ev");
      li.append(el("span", "bb-time", hhmm(ev.at)));
      const desc = el("div", "bb-desc");
      desc.append(el("div", null, evText(ev)));
      if (ev.note) desc.append(el("div", "bb-note", ev.note));
      li.append(desc);
      if (members.size > 1 && ev.by) {
        const chip = el("span", "who-chip", initial(ev.by));
        chip.style.background = personColor(ev.by);
        chip.title = members.get(ev.by) || "";
        li.append(chip);
      }
      li.addEventListener("click", () => openEditor(ev));
      ul.append(li);
    }
    return ul;
  }

  function renderSetup() {
    if (root.dataset.mode === "setup") return; // yazı yazılırken yeniden çizme
    root.dataset.mode = "setup";
    const c = el("section", "bb-card bb-setup");
    c.append(el("h3", null, "👶 Bebek takibi"),
      el("p", "muted", "Beslenmeleri eşinle birlikte, canlı olarak takip edin. Bilgiler yalnız ikinizde görünür."));
    const name = el("input"); name.type = "text"; name.maxLength = 40; name.autocomplete = "off";
    name.placeholder = "Bebeğin adı (takma ad yeterli)";
    const birth = el("input"); birth.type = "date";
    const seg = el("div", "bb-seg");
    REMIND_OPTS.forEach(([v, t]) => { const b = btn("", t); b.dataset.v = v; seg.append(b); });
    let rem = 3;
    wireSeg(seg, rem, (v) => { rem = +v; });
    const err = el("p", "hint err");
    const go = btn("btn-primary", "Başla", () => {
      const n = name.value.trim();
      if (!n) { err.textContent = "Bir ad yaz (takma ad yeterli)."; return; }
      go.disabled = true;
      setDoc(doc(collection(db, "spaces", sid, "babies")), {
        name: n.slice(0, 40), birthDate: birth.value || null, feedReminderHours: rem,
        createdBy: uid(), createdAt: serverTimestamp(), tz: TZ
      }).catch((e) => { go.disabled = false; err.textContent = "Kaydedilemedi. İnternetini kontrol et."; dbg("bebek oluştur HATA: " + (e.code || e.message)); });
    });
    c.append(name, el("div", "field-label", "Doğum tarihi (isteğe bağlı)"), birth,
      el("div", "field-label", "Beslenme hatırlatması"), seg,
      el("p", "hint", "Son beslenmeden bu kadar süre sonra ikinizin telefonuna bildirim gelir. Sonradan değiştirebilirsin."),
      go, err);
    root.replaceChildren(c);
  }

  /* ================= saat seçimi (formlarda ortak) ================= */
  // "Şimdi / 15 dk önce / 30 dk önce" kısayolları + serbest saat kutusu
  function wireWhen(mb, timeEl) {
    const box = mb.querySelector("#f-when");
    if (!box) return;
    const btns = [...box.querySelectorAll("button")];
    const pick = (b) => { btns.forEach((x) => x.classList.toggle("sel", x === b)); timeEl.value = hhmm(Date.now() - (+b.dataset.m) * MIN); };
    btns.forEach((b) => b.addEventListener("click", () => pick(b)));
    pick(btns[0]);
    timeEl.addEventListener("input", () => btns.forEach((x) => x.classList.remove("sel")));
  }
  // Gün + saat → zaman. Bugüne eklerken ileri bir saat girildiyse (ör. 00:10'da "23:50") dün sayılır.
  function resolveAt(baseDay, timeStr, isNewToday) {
    let at = atFromDayAndTime(baseDay, timeStr);
    if (!Number.isFinite(at)) return { error: "Saati kontrol et." };
    if (isNewToday && at > Date.now() + FUTURE_SLACK) at = addDays(at, -1);
    if (at > Date.now() + FUTURE_SLACK) return { error: "İleri bir saat girilemez." };
    return { at };
  }

  /* ================= biberon ================= */
  function openBottle(ev) {
    if (!bid) return;
    const editing = !!ev;
    let ml = editing ? ev.ml : (baby.lastBottleMl || 120);
    let milk = editing ? (ev.milk || null) : (baby.lastMilk ?? null);
    const baseDay = editing ? startOfDay(ev.at) : dayStart;
    const newToday = !editing && baseDay === startOfDay(Date.now());
    const ref = editing ? evRef(ev.id) : null;
    const mb = $("modal-body");
    openModal({
      title: editing ? "🍼 Biberonu düzenle" : "🍼 Biberon",
      autofocus: false,
      bodyHTML: `
        <div class="bb-amount">
          <button type="button" class="bb-step" data-step="-10" aria-label="10 ml azalt">−</button>
          <div class="bb-amount-val"><input id="f-ml" type="number" inputmode="numeric" min="1" max="500" aria-label="Miktar (ml)" /><span class="muted">ml</span></div>
          <button type="button" class="bb-step" data-step="10" aria-label="10 ml artır">+</button>
        </div>
        <div class="bb-chips" id="f-chips">${ML_CHIPS.map((v) => `<button type="button" data-v="${v}">${v}</button>`).join("")}</div>
        <div class="field-label">İçerik (isteğe bağlı)</div>
        <div class="bb-seg" id="f-milk"><button type="button" data-v="breast">Anne sütü</button><button type="button" data-v="formula">Mama</button></div>
        <div class="field-label">Saat</div>
        ${newToday ? `<div class="bb-seg" id="f-when"><button type="button" data-m="0">Şimdi</button><button type="button" data-m="15">15 dk önce</button><button type="button" data-m="30">30 dk önce</button></div>` : ""}
        <input id="f-time" type="time" aria-label="Saat" />
        <input id="f-note" type="text" maxlength="200" placeholder="Not (isteğe bağlı)" autocomplete="off" />
        ${editing ? `<button type="button" id="f-del" class="link-btn danger bb-del">Bu kaydı sil</button>` : ""}`,
      okText: "Kaydet",
      onOk: () => {
        const v = parseInt(mb.querySelector("#f-ml").value, 10);
        if (!Number.isInteger(v) || v < 1 || v > 500) { modalError("Miktar 1–500 ml arasında olmalı."); return false; }
        const r = resolveAt(baseDay, mb.querySelector("#f-time").value, newToday);
        if (r.error) { modalError(r.error); return false; }
        const note = mb.querySelector("#f-note").value.trim().slice(0, 200) || null;
        const data = { type: "feed", method: "bottle", at: r.at, ml: v, milk: milk || null, note, tz: TZ, updatedAt: serverTimestamp() };
        if (editing) {
          updateDoc(ref, data).catch(fail("Biberon"));
          toast("Güncellendi");
        } else {
          const b = writeBatch(db);
          b.set(doc(evCol()), { ...data, by: uid(), createdAt: serverTimestamp() });
          b.update(babyRef(), { lastBottleMl: v, lastMilk: milk || null });
          b.commit().catch(fail("Biberon"));
          toast(`🍼 ${v} ml kaydedildi`);
        }
      }
    });
    const mlEl = mb.querySelector("#f-ml");
    const chips = [...mb.querySelectorAll("#f-chips button")];
    const setMl = (x) => { ml = Math.max(1, Math.min(500, x)); mlEl.value = ml; chips.forEach((c) => c.classList.toggle("sel", +c.dataset.v === ml)); };
    setMl(ml);
    mb.querySelectorAll(".bb-step").forEach((b) => b.addEventListener("click", () => setMl((parseInt(mlEl.value, 10) || 0) + (+b.dataset.step))));
    chips.forEach((c) => c.addEventListener("click", () => setMl(+c.dataset.v)));
    mlEl.addEventListener("input", () => chips.forEach((c) => c.classList.toggle("sel", +c.dataset.v === parseInt(mlEl.value, 10))));
    wireSeg(mb.querySelector("#f-milk"), milk, (v) => { milk = v; }, true);
    const timeEl = mb.querySelector("#f-time");
    timeEl.value = hhmm(editing ? ev.at : Date.now());
    wireWhen(mb, timeEl);
    mb.querySelector("#f-note").value = editing ? (ev.note || "") : "";
    if (editing) mb.querySelector("#f-del").addEventListener("click", () => { closeModal(); deleteEvent(ev, ref); });
  }

  /* ================= emzirme ================= */
  function openBreast() {
    if (!bid) return;
    const mb = $("modal-body");
    openModal({
      title: "🤱 Emzirme",
      autofocus: false,
      showCancel: false,
      okText: "Vazgeç",
      bodyHTML: `
        <div class="bb-bigbtns"><button type="button" class="bb-bigbtn" data-side="L">Sol ile başla</button><button type="button" class="bb-bigbtn" data-side="R">Sağ ile başla</button></div>
        <p class="hint">Sayaç başlar; telefonu kilitlesen de sürer ve eşin de görür. Bitince “Bitir”e bas.</p>
        <button type="button" id="f-manual" class="link-btn">Geçmiş bir emzirmeyi elle ekle</button>`
    });
    mb.querySelectorAll(".bb-bigbtn").forEach((b) => b.addEventListener("click", () => { closeModal(); timerStart(b.dataset.side); }));
    mb.querySelector("#f-manual").addEventListener("click", () => { closeModal(); openBreastManual(); });
  }

  function openBreastManual(ev) {
    if (!bid) return;
    const editing = !!ev;
    let side = editing ? ev.side : "L";
    let dur = editing ? Math.max(1, Math.round((ev.endAt - ev.at) / MIN)) : 15;
    const baseDay = editing ? startOfDay(ev.at) : dayStart;
    const newToday = !editing && baseDay === startOfDay(Date.now());
    const ref = editing ? evRef(ev.id) : null;
    const mb = $("modal-body");
    openModal({
      title: editing ? "🤱 Emzirmeyi düzenle" : "🤱 Emzirme ekle",
      autofocus: false,
      bodyHTML: `
        <div class="field-label">Taraf</div>
        <div class="bb-seg" id="f-side"><button type="button" data-v="L">Sol</button><button type="button" data-v="R">Sağ</button><button type="button" data-v="both">İki taraf</button></div>
        <div class="field-label">Başlangıç saati</div>
        <input id="f-time" type="time" aria-label="Başlangıç saati" />
        <div class="field-label">Süre (dakika)</div>
        <div class="bb-chips" id="f-durchips">${DUR_CHIPS.map((v) => `<button type="button" data-v="${v}">${v}</button>`).join("")}</div>
        <input id="f-dur" type="number" min="1" max="360" inputmode="numeric" aria-label="Süre (dakika)" />
        <input id="f-note" type="text" maxlength="200" placeholder="Not (isteğe bağlı)" autocomplete="off" />
        ${editing ? `<button type="button" id="f-del" class="link-btn danger bb-del">Bu kaydı sil</button>` : ""}`,
      okText: "Kaydet",
      onOk: () => {
        const d = parseInt(mb.querySelector("#f-dur").value, 10);
        if (!Number.isInteger(d) || d < 1 || d > 360) { modalError("Süre 1–360 dakika olmalı."); return false; }
        const r = resolveAt(baseDay, mb.querySelector("#f-time").value, newToday);
        if (r.error) { modalError(r.error); return false; }
        const note = mb.querySelector("#f-note").value.trim().slice(0, 200) || null;
        const data = { type: "feed", method: "breast", at: r.at, endAt: r.at + d * MIN, side, note, tz: TZ, updatedAt: serverTimestamp() };
        if (editing) { updateDoc(ref, data).catch(fail("Emzirme")); toast("Güncellendi"); }
        else {
          setDoc(doc(evCol()), { ...data, by: uid(), createdAt: serverTimestamp() }).catch(fail("Emzirme"));
          toast(`🤱 ${SIDE[side]} · ${d} dk kaydedildi`);
        }
      }
    });
    wireSeg(mb.querySelector("#f-side"), side, (v) => { side = v; });
    const durEl = mb.querySelector("#f-dur");
    const durChips = [...mb.querySelectorAll("#f-durchips button")];
    const setDur = (x) => { dur = x; durEl.value = x; durChips.forEach((c) => c.classList.toggle("sel", +c.dataset.v === x)); };
    setDur(dur);
    durChips.forEach((c) => c.addEventListener("click", () => setDur(+c.dataset.v)));
    durEl.addEventListener("input", () => durChips.forEach((c) => c.classList.toggle("sel", +c.dataset.v === parseInt(durEl.value, 10))));
    mb.querySelector("#f-time").value = hhmm(editing ? ev.at : Date.now() - dur * MIN);
    mb.querySelector("#f-note").value = editing ? (ev.note || "") : "";
    if (editing) mb.querySelector("#f-del").addEventListener("click", () => { closeModal(); deleteEvent(ev, ref); });
  }

  // Sayaç bebek belgesinde tutulur → telefon kapansa da sürer, iki telefonda da görünür
  function timerStart(side) {
    updateDoc(babyRef(), { activeTimer: { kind: "breast", side, startedAt: Date.now(), startedBy: uid() } })
      .catch(fail("Sayaç"));
  }
  function timerEvent(t, endAt) {
    const end = Math.max(t.startedAt, Math.min(endAt, t.startedAt + MAX_BREAST_MS));
    const by = members.has(t.startedBy) ? t.startedBy : uid();
    return { type: "feed", method: "breast", at: t.startedAt, endAt: end, side: t.side, note: null, tz: TZ,
      by, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  }
  function timerSwitch() {
    const t = baby && baby.activeTimer; if (!t) return;
    const now = Date.now(), b = writeBatch(db);
    b.set(doc(evCol()), timerEvent(t, now));
    b.update(babyRef(), { activeTimer: { kind: "breast", side: t.side === "L" ? "R" : "L", startedAt: now, startedBy: uid() } });
    b.commit().catch(fail("Emzirme"));
    toast(`${SIDE[t.side]} taraf kaydedildi (${durText(now - t.startedAt)})`);
  }
  function timerFinish() {
    const t = baby && baby.activeTimer; if (!t) return;
    const now = Date.now(), b = writeBatch(db);
    b.set(doc(evCol()), timerEvent(t, now));
    b.update(babyRef(), { activeTimer: null });
    b.commit().catch(fail("Emzirme"));
    toast(now - t.startedAt > MAX_BREAST_MS ? "Süre 6 saatle sınırlandı ve kaydedildi"
      : `🤱 ${SIDE[t.side]} · ${durText(now - t.startedAt)} kaydedildi`);
  }
  function timerCancel() {
    openModal({
      title: "Sayacı iptal et", autofocus: false, okText: "İptal et", okDanger: true,
      bodyHTML: '<p class="hint">Bu emzirme <b>kaydedilmeyecek</b>. Emin misin?</p>',
      onOk: () => { updateDoc(babyRef(), { activeTimer: null }).catch(fail("Sayaç")); }
    });
  }

  /* ================= gelişim + haftalık özet ================= */
  function linksRow() {
    const r = el("div", "bb-links");
    r.append(btn("btn-secondary", "📈 Gelişim", openGrowthView), btn("btn-secondary", "📊 Son 7 gün", openWeekly));
    if (!meds.length) r.append(btn("btn-secondary wide", "💊 Vitamin / ilaç hatırlatması ekle", () => openMedEdit()));
    return r;
  }
  const shortDate = (ms) => new Date(ms).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  // Veri yüklenirken pencere kapatılıp başka pencere açıldıysa, geç gelen içerik onun ÜZERİNE yazılmasın
  const modalStillIs = (title) => !$("modal-overlay").classList.contains("hidden") && $("modal-title").textContent === title;

  async function openGrowthView() {
    if (!bid) return;
    const mb = $("modal-body");
    openModal({ title: "📈 Gelişim", autofocus: false, showCancel: false, okText: "Kapat",
      bodyHTML: `<p class="muted">Yükleniyor…</p>` });
    let list = [];
    try {
      const snap = await getDocs(query(evCol(), where("type", "==", "growth"), orderBy("at", "desc")));
      list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) { dbg("gelişim HATA: " + (e.code || e.message)); if (modalStillIs("📈 Gelişim")) mb.replaceChildren(el("p", "muted", "Ölçümler yüklenemedi.")); return; }
    if (!modalStillIs("📈 Gelişim")) return;
    const METRICS = [
      ["weightG", "Kilo", (v) => fmtG(v)],
      ["lengthMm", "Boy", (v) => fmtCm(v)],
      ["headMm", "Baş", (v) => fmtCm(v)]
    ];
    let metric = "weightG";
    const tabs = el("div", "bb-seg");
    const chartBox = el("div");
    const drawChart = () => {
      const [, , f] = METRICS.find((m) => m[0] === metric);
      const pts = list.filter((g) => g[metric] != null).map((g) => ({ at: g.at, v: g[metric] })).sort((a, b) => a.at - b.at);
      chartBox.replaceChildren(lineChart({ points: pts, valFmt: f, dateFmt: shortDate }));
    };
    METRICS.forEach(([k, t]) => { const b = btn("", t); b.dataset.v = k; tabs.append(b); });
    wireSeg(tabs, metric, (v) => { metric = v; drawChart(); });
    const add = btn("btn-primary bb-add", "+ Ölçüm ekle", () => { closeModal(); openGrowth(); });
    const ul = el("ul", "bb-list");
    if (!list.length) ul.append(el("li", "bb-empty muted", "Henüz ölçüm yok. Doktor kontrolünde ya da evde tartınca ekleyebilirsin."));
    for (const g of list) {
      const li = el("li", "bb-ev");
      li.append(el("span", "bb-time bb-date", shortDate(g.at)));
      const desc = el("div", "bb-desc");
      desc.append(el("div", null, growthText(g)));
      if (g.note) desc.append(el("div", "bb-note", g.note));
      li.append(desc);
      li.addEventListener("click", () => { closeModal(); openGrowth(g); });
      ul.append(li);
    }
    mb.replaceChildren(tabs, chartBox, add, ul);
    drawChart();
  }

  function openGrowth(ev) {
    if (!bid) return;
    const editing = !!ev;
    const ref = editing ? evRef(ev.id) : null;
    const mb = $("modal-body");
    const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    openModal({
      title: editing ? "📏 Ölçümü düzenle" : "📏 Ölçüm ekle",
      autofocus: false,
      bodyHTML: `
        <div class="field-label">Tarih</div>
        <input id="g-date" type="date" />
        <div class="field-label">Kilo (gram)</div>
        <input id="g-w" type="number" inputmode="numeric" min="500" max="30000" placeholder="ör. 3650" />
        <div class="field-label">Boy (cm)</div>
        <input id="g-l" type="text" inputmode="decimal" maxlength="6" placeholder="ör. 52,5" autocomplete="off" />
        <div class="field-label">Baş çevresi (cm)</div>
        <input id="g-h" type="text" inputmode="decimal" maxlength="6" placeholder="ör. 35,5" autocomplete="off" />
        <input id="f-note" type="text" maxlength="200" placeholder="Not (isteğe bağlı, ör. doktor kontrolü)" autocomplete="off" />
        <p class="hint">Bildiğin ölçümleri gir; boş bırakılanlar kaydedilmez.</p>
        ${editing ? `<button type="button" id="f-del" class="link-btn danger bb-del">Bu ölçümü sil</button>` : ""}`,
      okText: "Kaydet",
      onOk: () => {
        const ds = mb.querySelector("#g-date").value;
        const [yy, mm, dd] = ds.split("-").map((x) => parseInt(x, 10));
        if (!yy || !mm || !dd) { modalError("Tarihi seç."); return false; }
        let at = new Date(yy, mm - 1, dd, 12, 0, 0, 0).getTime();
        if (startOfDay(at) > startOfDay(Date.now())) { modalError("İleri bir tarih seçilemez."); return false; }
        if (at > Date.now()) at = Date.now(); // bugün ve öğleden önce
        const wRaw = mb.querySelector("#g-w").value.trim();
        const weightG = wRaw ? parseInt(wRaw, 10) : null;
        const lengthMm = parseCmToMm(mb.querySelector("#g-l").value);
        const headMm = parseCmToMm(mb.querySelector("#g-h").value);
        if (weightG == null && lengthMm == null && headMm == null) { modalError("En az bir ölçüm gir."); return false; }
        if (weightG != null && !(Number.isInteger(weightG) && weightG >= 500 && weightG <= 30000)) { modalError("Kilo 500–30000 gram arasında olmalı (ör. 3650)."); return false; }
        if (lengthMm != null && !(lengthMm >= 250 && lengthMm <= 1300)) { modalError("Boy 25–130 cm arasında olmalı."); return false; }
        if (headMm != null && !(headMm >= 200 && headMm <= 600)) { modalError("Baş çevresi 20–60 cm arasında olmalı."); return false; }
        const note = mb.querySelector("#f-note").value.trim().slice(0, 200) || null;
        const data = { type: "growth", at, weightG, lengthMm, headMm, note, tz: TZ, updatedAt: serverTimestamp() };
        if (editing) { updateDoc(ref, data).catch(fail("Ölçüm")); toast("Güncellendi"); }
        else { setDoc(doc(evCol()), { ...data, by: uid(), createdAt: serverTimestamp() }).catch(fail("Ölçüm")); toast(`📏 ${growthText(data)} kaydedildi`); }
      }
    });
    mb.querySelector("#g-date").value = toDateInput(editing ? ev.at : Date.now());
    mb.querySelector("#g-w").value = editing && ev.weightG != null ? ev.weightG : "";
    mb.querySelector("#g-l").value = editing && ev.lengthMm != null ? String(ev.lengthMm / 10).replace(".", ",") : "";
    mb.querySelector("#g-h").value = editing && ev.headMm != null ? String(ev.headMm / 10).replace(".", ",") : "";
    mb.querySelector("#f-note").value = editing ? (ev.note || "") : "";
    if (editing) mb.querySelector("#f-del").addEventListener("click", () => { closeModal(); deleteEvent(ev, ref); });
  }

  // Son 7 gün (bugün dahil): süt (ml), bez (adet), uyku (saat) — üç ayrı grafik (tek eksen kuralı)
  async function openWeekly() {
    if (!bid) return;
    const mb = $("modal-body");
    openModal({ title: "📊 Son 7 gün", autofocus: false, showCancel: false, okText: "Kapat",
      bodyHTML: `<p class="muted">Yükleniyor…</p>` });
    const today = startOfDay(Date.now());
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
    let evs = [];
    try {
      const snap = await getDocs(query(evCol(), where("at", ">=", days[0]), orderBy("at")));
      evs = snap.docs.map((d) => d.data());
    } catch (e) { dbg("haftalık HATA: " + (e.code || e.message)); if (modalStillIs("📊 Son 7 gün")) mb.replaceChildren(el("p", "muted", "Veriler yüklenemedi.")); return; }
    if (!modalStillIs("📊 Son 7 gün")) return;
    const ml = Array(7).fill(0), diapers = Array(7).fill(0), sleepH = Array(7).fill(0);
    for (const ev of evs) {
      const i = days.findIndex((d, k) => ev.at >= d && (k === 6 || ev.at < days[k + 1]));
      if (i < 0) continue;
      if (ev.type === "feed" && ev.method === "bottle") ml[i] += ev.ml || 0;
      else if (ev.type === "diaper") diapers[i]++;
      else if (ev.type === "sleep") sleepH[i] += Math.max(0, (ev.endAt || ev.at) - ev.at) / HOUR;
    }
    const labels = days.map((d) => new Date(d).toLocaleDateString("tr-TR", { weekday: "short" }));
    const fullLabels = days.map((d) => new Date(d).toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" }));
    const common = { labels, fullLabels, todayIdx: 6 };
    const oneDec = (v) => (Math.round(v * 10) / 10).toLocaleString("tr-TR", { maximumFractionDigits: 1 });
    mb.replaceChildren(
      barChart({ title: "🍼 Biberon (ml)", unitFmt: (v) => `${Math.round(v)} ml`, values: ml, ...common }),
      barChart({ title: "🧷 Bez", unitFmt: (v) => `${oneDec(v)} bez`, values: diapers, ...common }),
      barChart({ title: "😴 Uyku", unitFmt: (v) => `${oneDec(v)} sa`, values: sleepH, ...common }),
      el("p", "hint", "Emzirme süreleri ml grafiğine katılmaz. Gece yarısını geçen uyku başladığı güne yazılır.")
    );
  }

  /* ================= vitamin / ilaç (günlük takviye) ================= */
  // Takviye belgesi: meds/m1..m5 { name, time "SS:DD", lastGivenAt/By, lastEventId, notifyAt, remindN }.
  // Bildirimi SUNUCU gönderir (functions: notifyAt'e bakar; verilmişse atlar, 1 saat sonra bir kez daha).
  // "Verdim" = bir events kaydı (geçmişte görünsün) + takviye belgesinde lastGivenAt (eşin telefonunda ✓).
  const givenToday = (m) => !!m.lastGivenAt && m.lastGivenAt >= startOfDay(Date.now());
  // Bu saatin bir sonraki gelişi (bugün geçtiyse yarın) — cihazın yerel saatiyle
  function nextLocal(time) {
    const today = startOfDay(Date.now());
    const t = atFromDayAndTime(today, time);
    return t > Date.now() ? t : atFromDayAndTime(addDays(today, 1), time);
  }

  function medsCard() {
    const c = el("section", "bb-card bb-meds");
    const head = el("div", "bb-row");
    head.append(el("span", "bb-label", "💊 Bugün"), btn("link-btn bb-meds-edit", "Düzenle", openMeds));
    c.append(head);
    for (const m of meds) {
      const done = givenToday(m);
      const row = btn("bb-med" + (done ? " done" : ""), null, () => (done ? openMedGiven(m) : markGiven(m)));
      const txt = el("span", "bb-med-txt");
      txt.append(el("span", "bb-med-name", m.name));
      const late = !done && atFromDayAndTime(startOfDay(Date.now()), m.time) < Date.now();
      txt.append(el("span", "bb-med-sub" + (late ? " late" : ""), late ? `${m.time} · saati geçti` : m.time));
      const who = members.size > 1 && m.lastGivenBy ? ` · ${initial(m.lastGivenBy)}` : "";
      row.append(txt, el("span", "bb-med-state", done ? `✓ ${hhmm(m.lastGivenAt)}${who}` : "Verdim"));
      row.setAttribute("aria-label", done ? `${m.name}: bugün ${hhmm(m.lastGivenAt)} verildi` : `${m.name}: verildi olarak işaretle`);
      c.append(row);
    }
    return c;
  }

  // Tek dokunuş: şimdi verildi. Yollar dokunma anında sabitlenir ("Geri al" doğru yere yazsın).
  function markGiven(m) {
    if (!bid) return;
    const eref = doc(evCol()), mref = medRef(m.id), now = Date.now();
    const prev = { lastGivenAt: m.lastGivenAt ?? null, lastGivenBy: m.lastGivenBy ?? null, lastEventId: m.lastEventId ?? null };
    const b = writeBatch(db);
    b.set(eref, { type: "med", at: now, medId: m.id, name: m.name, note: null, by: uid(), tz: TZ,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b.update(mref, { lastGivenAt: now, lastGivenBy: uid(), lastEventId: eref.id });
    b.commit().catch(fail("Takviye"));
    showSnackbar(`💊 ${m.name} verildi`, () => {
      const u = writeBatch(db); u.delete(eref); u.update(mref, prev); u.commit().catch(fail("Geri alma"));
    });
  }

  // Kaydı sil; takviyenin "bugün verildi" işareti BU kayıttan geliyorsa onu da kaldır. "Geri al" ikisini de geri yazar.
  function removeMedEvent(ev) {
    const eref = evRef(ev.id);
    const m = meds.find((x) => x.id === ev.medId);
    const touch = !!m && m.lastEventId === ev.id;
    const mref = touch ? medRef(m.id) : null;
    const prev = touch ? { lastGivenAt: m.lastGivenAt, lastGivenBy: m.lastGivenBy, lastEventId: m.lastEventId } : null;
    const b = writeBatch(db);
    b.delete(eref);
    if (touch) b.update(mref, { lastGivenAt: null, lastGivenBy: null, lastEventId: null });
    b.commit().catch(fail("Silme"));
    const { id, ...data } = ev;
    showSnackbar("İşaret kaldırıldı", () => {
      const u = writeBatch(db);
      u.set(eref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      if (touch) u.update(mref, prev);
      u.commit().catch(fail("Geri alma"));
    });
  }

  function medGivenModal(title, info, ev) {
    const mb = $("modal-body");
    openModal({ title, autofocus: false, showCancel: false, okText: "Kapat",
      bodyHTML: `<p class="hint" id="md-info"></p><button type="button" id="md-del" class="link-btn danger bb-del">Verilmedi say (işareti kaldır)</button>` });
    mb.querySelector("#md-info").textContent = info;
    mb.querySelector("#md-del").addEventListener("click", () => { closeModal(); removeMedEvent(ev); });
  }
  // Karttaki ✓ satırına dokununca: bilgi + işareti kaldırma
  function openMedGiven(m) {
    const who = members.size > 1 && m.lastGivenBy ? ` (${initial(m.lastGivenBy)})` : "";
    medGivenModal(`💊 ${m.name}`, `Bugün verildi · saat ${hhmm(m.lastGivenAt)}${who}`,
      { id: m.lastEventId || "yok", type: "med", at: m.lastGivenAt, medId: m.id, name: m.name, note: null, by: m.lastGivenBy || uid(), tz: TZ });
  }
  // Günlük listedeki vitamin kaydına dokununca
  function openMedEv(ev) {
    const who = members.size > 1 && ev.by ? ` (${initial(ev.by)})` : "";
    medGivenModal(`💊 ${ev.name}`, `${dayLabel(startOfDay(ev.at))} verildi · saat ${hhmm(ev.at)}${who}`, ev);
  }

  // Takviye listesi (düzenle / ekle)
  function openMeds() {
    const mb = $("modal-body");
    openModal({ title: "💊 Vitamin / ilaç", autofocus: false, showCancel: false, okText: "Kapat", bodyHTML: "" });
    const ul = el("ul", "bb-list");
    for (const m of meds) {
      const li = el("li", "bb-ev");
      li.append(el("span", "bb-time", m.time));
      const desc = el("div", "bb-desc"); desc.append(el("div", null, m.name));
      li.append(desc);
      li.addEventListener("click", () => { closeModal(); openMedEdit(m); });
      ul.append(li);
    }
    mb.append(ul);
    if (meds.length < MED_IDS.length) mb.append(btn("btn-primary bb-add", "+ Takviye ekle", () => { closeModal(); openMedEdit(); }));
    mb.append(el("p", "hint", "Dokunarak adını/saatini değiştirebilir ya da silebilirsin. En fazla 5 takviye."));
  }

  function openMedEdit(m) {
    if (!bid) return;
    const editing = !!m;
    const freeId = MED_IDS.find((x) => !meds.some((y) => y.id === x));
    if (!editing && !freeId) { toast("En fazla 5 takviye eklenebilir."); return; }
    const id = editing ? m.id : freeId, mref = medRef(id);
    const mb = $("modal-body");
    openModal({
      title: editing ? "💊 Takviyeyi düzenle" : "💊 Takviye ekle",
      autofocus: false,
      bodyHTML: `
        <div class="field-label">Adı</div>
        <input id="md-name" type="text" maxlength="40" autocomplete="off" placeholder="ör. D vitamini" />
        <div class="field-label">Her gün saat</div>
        <input id="md-time" type="time" aria-label="Hatırlatma saati" />
        <p class="hint">Bu saatte ikinizin telefonuna bildirim gelir. 1 saat içinde kimse işaretlemezse bir kez daha hatırlatılır. Biriniz “Verdim”e basınca diğerinde de ✓ görünür.</p>
        ${editing ? `<button type="button" id="md-remove" class="link-btn danger bb-del">Bu takviyeyi sil</button>` : ""}`,
      okText: "Kaydet",
      onOk: () => {
        const name = mb.querySelector("#md-name").value.trim();
        const time = mb.querySelector("#md-time").value;
        if (!name || name.length > 40) { modalError("Ad 1–40 karakter olmalı."); return false; }
        if (!TIME_RE.test(time)) { modalError("Saati seç."); return false; }
        const data = { name, time, tz: TZ, updatedAt: serverTimestamp(), notifyAt: nextLocal(time), remindN: 0 };
        if (editing) updateDoc(mref, data).catch(fail("Takviye"));
        else setDoc(mref, { ...data, createdBy: uid(), createdAt: serverTimestamp(), lastGivenAt: null, lastGivenBy: null, lastEventId: null }).catch(fail("Takviye"));
        toast(editing ? "Güncellendi" : `💊 ${name} eklendi · her gün ${time}`);
      }
    });
    mb.querySelector("#md-name").value = editing ? m.name : (meds.length ? "" : "D vitamini");
    mb.querySelector("#md-time").value = editing ? m.time : "09:00";
    if (editing) mb.querySelector("#md-remove").addEventListener("click", () => {
      closeModal();
      const { id: _id, ...data } = m;
      deleteDoc(mref).catch(fail("Silme"));
      // Geri al: yeniden oluşturur (kurallar gereği oluşturan = geri alan kişi). Geçmiş kayıtlar zaten silinmez.
      showSnackbar(`💊 ${m.name} silindi`, () => setDoc(mref, { ...data, createdBy: uid(), notifyAt: nextLocal(m.time), remindN: 0 }).catch(fail("Geri alma")));
    });
  }

  // Listedeki kayda dokununca türüne uygun düzenleyiciyi aç
  function openEditor(ev) {
    if (ev.type === "diaper") return openDiaper(ev);
    if (ev.type === "sleep") return openSleepManual(ev);
    if (ev.type === "growth") return openGrowth(ev);
    if (ev.type === "med") return openMedEv(ev);
    return ev.method === "bottle" ? openBottle(ev) : openBreastManual(ev);
  }

  /* ================= bez ================= */
  // Yeni kayıt: türe (Islak/Kirli/İkisi) dokunmak = HEMEN KAYDET (2 dokunuş). Saat/not önce ayarlanabilir.
  // Düzenleme: türü seç, sonra Kaydet.
  function openDiaper(ev) {
    if (!bid) return;
    const editing = !!ev;
    const baseDay = editing ? startOfDay(ev.at) : dayStart;
    const newToday = !editing && baseDay === startOfDay(Date.now());
    const ref = editing ? evRef(ev.id) : null;
    const KINDS = [["pee", "💧 Islak"], ["poo", "💩 Kirli"], ["both", "💧💩 İkisi"]];
    let kind = editing ? (ev.pee && ev.poo ? "both" : ev.poo ? "poo" : "pee") : null;
    const mb = $("modal-body");
    const save = (k) => {
      const r = resolveAt(baseDay, mb.querySelector("#f-time").value, newToday);
      if (r.error) { modalError(r.error); return false; }
      const note = mb.querySelector("#f-note").value.trim().slice(0, 200) || null;
      const data = { type: "diaper", at: r.at, pee: k !== "poo", poo: k !== "pee", note, tz: TZ, updatedAt: serverTimestamp() };
      if (editing) { updateDoc(ref, data).catch(fail("Bez")); toast("Güncellendi"); }
      else { setDoc(doc(evCol()), { ...data, by: uid(), createdAt: serverTimestamp() }).catch(fail("Bez")); toast(`${diaperText(data)} kaydedildi`); }
      return true;
    };
    openModal({
      title: editing ? "🧷 Bezi düzenle" : "🧷 Bez",
      autofocus: false,
      showCancel: editing,
      okText: editing ? "Kaydet" : "Vazgeç",
      bodyHTML: `
        <div class="bb-bigbtns three${editing ? " pick" : ""}" id="f-kind">${KINDS.map(([v, t]) => `<button type="button" class="bb-bigbtn" data-v="${v}">${t}</button>`).join("")}</div>
        <p class="hint">${editing ? "Türü seç, sonra Kaydet." : "Türe dokununca hemen kaydedilir. Saati değiştirmek istersen önce aşağıdan ayarla."}</p>
        <div class="field-label">Saat</div>
        ${newToday ? WHEN_HTML : ""}
        <input id="f-time" type="time" aria-label="Saat" />
        <input id="f-note" type="text" maxlength="200" placeholder="Not (isteğe bağlı)" autocomplete="off" />
        ${editing ? `<button type="button" id="f-del" class="link-btn danger bb-del">Bu kaydı sil</button>` : ""}`,
      onOk: editing ? () => (save(kind) ? undefined : false) : undefined
    });
    const kindBtns = [...mb.querySelectorAll("#f-kind button")];
    const paint = () => kindBtns.forEach((b) => b.classList.toggle("sel", b.dataset.v === kind));
    paint();
    kindBtns.forEach((b) => b.addEventListener("click", () => {
      kind = b.dataset.v;
      if (editing) paint();
      else if (save(kind)) closeModal();
    }));
    const timeEl = mb.querySelector("#f-time");
    timeEl.value = hhmm(editing ? ev.at : Date.now());
    wireWhen(mb, timeEl);
    mb.querySelector("#f-note").value = editing ? (ev.note || "") : "";
    if (editing) mb.querySelector("#f-del").addEventListener("click", () => { closeModal(); deleteEvent(ev, ref); });
  }

  /* ================= uyku ================= */
  function openSleep() {
    if (!bid) return;
    const mb = $("modal-body");
    openModal({
      title: "😴 Uyku", autofocus: false, showCancel: false, okText: "Vazgeç",
      bodyHTML: `
        <div class="bb-bigbtns one"><button type="button" class="bb-bigbtn" id="f-sleepnow">😴 Şimdi uyudu — sayacı başlat</button></div>
        <p class="hint">Uyanınca “Uyandı”ya bas. Telefonu kilitlesen de sayaç sürer ve eşin de görür.</p>
        <button type="button" id="f-manual" class="link-btn">Geçmiş bir uykuyu elle ekle</button>`
    });
    mb.querySelector("#f-sleepnow").addEventListener("click", () => { closeModal(); sleepStart(); });
    mb.querySelector("#f-manual").addEventListener("click", () => { closeModal(); openSleepManual(); });
  }

  function openSleepManual(ev) {
    if (!bid) return;
    const editing = !!ev;
    let dur = editing ? Math.max(1, Math.round((ev.endAt - ev.at) / MIN)) : 60;
    const baseDay = editing ? startOfDay(ev.at) : dayStart;
    const newToday = !editing && baseDay === startOfDay(Date.now());
    const ref = editing ? evRef(ev.id) : null;
    const mb = $("modal-body");
    openModal({
      title: editing ? "😴 Uykuyu düzenle" : "😴 Uyku ekle",
      autofocus: false,
      bodyHTML: `
        <div class="field-label">Uyuduğu saat</div>
        <input id="f-time" type="time" aria-label="Uyuduğu saat" />
        <div class="field-label">Süre</div>
        <div class="bb-chips" id="f-durchips">${SLEEP_CHIPS.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join("")}</div>
        <input id="f-dur" type="number" min="1" max="960" inputmode="numeric" aria-label="Süre (dakika)" placeholder="Dakika" />
        <input id="f-note" type="text" maxlength="200" placeholder="Not (isteğe bağlı)" autocomplete="off" />
        ${editing ? `<button type="button" id="f-del" class="link-btn danger bb-del">Bu kaydı sil</button>` : ""}`,
      okText: "Kaydet",
      onOk: () => {
        const d = parseInt(mb.querySelector("#f-dur").value, 10);
        if (!Number.isInteger(d) || d < 1 || d > 960) { modalError("Süre 1–960 dakika (en fazla 16 saat) olmalı."); return false; }
        const r = resolveAt(baseDay, mb.querySelector("#f-time").value, newToday);
        if (r.error) { modalError(r.error); return false; }
        const endAt = r.at + d * MIN;
        if (endAt > Date.now() + FUTURE_SLACK) { modalError("Uyku bitişi şu andan ileri olamaz. Saati ya da süreyi düzelt."); return false; }
        const note = mb.querySelector("#f-note").value.trim().slice(0, 200) || null;
        const data = { type: "sleep", at: r.at, endAt, note, tz: TZ, updatedAt: serverTimestamp() };
        if (editing) { updateDoc(ref, data).catch(fail("Uyku")); toast("Güncellendi"); }
        else {
          setDoc(doc(evCol()), { ...data, by: uid(), createdAt: serverTimestamp() }).catch(fail("Uyku"));
          toast(`😴 ${durText(d * MIN)} uyku kaydedildi`);
        }
      }
    });
    const durEl = mb.querySelector("#f-dur");
    const chips = [...mb.querySelectorAll("#f-durchips button")];
    const setDur = (x) => { dur = x; durEl.value = x; chips.forEach((c) => c.classList.toggle("sel", +c.dataset.v === x)); };
    setDur(dur);
    chips.forEach((c) => c.addEventListener("click", () => setDur(+c.dataset.v)));
    durEl.addEventListener("input", () => chips.forEach((c) => c.classList.toggle("sel", +c.dataset.v === parseInt(durEl.value, 10))));
    mb.querySelector("#f-time").value = hhmm(editing ? ev.at : Date.now() - dur * MIN);
    mb.querySelector("#f-note").value = editing ? (ev.note || "") : "";
    if (editing) mb.querySelector("#f-del").addEventListener("click", () => { closeModal(); deleteEvent(ev, ref); });
  }

  // Uyku sayacı da bebek belgesinde → telefon kapansa da sürer, iki telefonda görünür
  function sleepStart() {
    updateDoc(babyRef(), { sleepTimer: { startedAt: Date.now(), startedBy: uid() } }).catch(fail("Uyku sayacı"));
  }
  function sleepFinish() {
    const t = baby && baby.sleepTimer; if (!t) return;
    const now = Date.now();
    const end = Math.max(t.startedAt, Math.min(now, t.startedAt + MAX_SLEEP_MS));
    const by = members.has(t.startedBy) ? t.startedBy : uid();
    const b = writeBatch(db);
    b.set(doc(evCol()), { type: "sleep", at: t.startedAt, endAt: end, note: null, tz: TZ, by,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b.update(babyRef(), { sleepTimer: null });
    b.commit().catch(fail("Uyku"));
    toast(now - t.startedAt > MAX_SLEEP_MS ? "Uyku 16 saatle sınırlandı ve kaydedildi" : `😴 ${durText(end - t.startedAt)} uyku kaydedildi`);
  }
  function sleepCancel() {
    openModal({
      title: "Uyku sayacını iptal et", autofocus: false, okText: "İptal et", okDanger: true,
      bodyHTML: '<p class="hint">Bu uyku <b>kaydedilmeyecek</b>. Emin misin?</p>',
      onOk: () => { updateDoc(babyRef(), { sleepTimer: null }).catch(fail("Uyku sayacı")); }
    });
  }
  function sleepCard() {
    const t = baby.sleepTimer;
    const c = el("section", "bb-card bb-timer");
    const by = t.startedBy && t.startedBy !== uid() && members.size > 1 ? ` · ${initial(t.startedBy)} başlattı` : "";
    c.append(el("div", "bb-label", `😴 Uyuyor · ${hhmm(t.startedAt)}${by}`));
    const big = el("div", "bb-big bb-clock", clock(Date.now() - t.startedAt)); big.id = "bb-stimer";
    const acts = el("div", "bb-timer-actions");
    acts.append(btn("btn-primary", "Uyandı", sleepFinish));
    c.append(big, acts, btn("link-btn danger bb-cancel", "Sayacı iptal et", sleepCancel));
    return c;
  }

  // Sil + "Geri al" (5 sn). Yol silme anında sabitlenir (sonra alan değişse bile doğru yere geri yazar).
  function deleteEvent(ev, ref) {
    const { id, ...data } = ev;
    deleteDoc(ref).catch(fail("Silme"));
    showSnackbar("Kayıt silindi", () => setDoc(ref, data).catch(fail("Geri alma")));
  }

  /* ================= ayarlar ================= */
  function openSettings() {
    if (!bid || !baby) return;
    let rem = baby.feedReminderHours || 0;
    const mb = $("modal-body");
    openModal({
      title: "👶 Bebek ayarları",
      autofocus: false,
      bodyHTML: `
        <div class="field-label">Adı (takma ad yeterli)</div>
        <input id="s-name" type="text" maxlength="40" autocomplete="off" />
        <div class="field-label">Doğum tarihi (isteğe bağlı)</div>
        <input id="s-birth" type="date" />
        <div class="field-label">Beslenme hatırlatması</div>
        <div class="bb-seg" id="s-rem">${REMIND_OPTS.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join("")}</div>
        <p class="hint">Son beslenmenin başlangıcından bu kadar süre sonra ikinizin telefonuna bildirim gelir. Emzirme sürerken bildirim gönderilmez.</p>`,
      okText: "Kaydet",
      onOk: () => {
        const name = mb.querySelector("#s-name").value.trim();
        if (!name || name.length > 40) { modalError("Ad 1–40 karakter olmalı."); return false; }
        const birthDate = mb.querySelector("#s-birth").value || null;
        updateDoc(babyRef(), { name, birthDate, feedReminderHours: rem }).catch(fail("Ayarlar"));
        toast("Kaydedildi");
      }
    });
    mb.querySelector("#s-name").value = baby.name || "";
    mb.querySelector("#s-birth").value = baby.birthDate || "";
    wireSeg(mb.querySelector("#s-rem"), rem, (v) => { rem = +v; });
  }

  function title() { return baby ? `👶 ${baby.name}` : "👶 Bebek"; }

  return { start, stop, resync, title, openSettings };
}
