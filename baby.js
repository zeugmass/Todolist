// ============================================================================
// BEBEK TAKİBİ — Faz 1: beslenme (biberon + emzirme sayacı + hatırlatma)
// app.js'ten createBabyTracker(ctx) ile kurulur.
// Veri: spaces/{sid}/babies/{bid}  ve  spaces/{sid}/babies/{bid}/events/{eid}
// GÜVENLİK: kullanıcı verisi (ad, not, e-posta) ASLA innerHTML'e yazılmaz;
// yalnız textContent/value kullanılır. Kurallar: firestore.rules (validBaby/validFeed).
// ============================================================================
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, limit, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const ML_CHIPS = [60, 90, 120, 150, 180];
const DUR_CHIPS = [5, 10, 15, 20, 30];
const MILK = { breast: "Anne sütü", formula: "Mama" };
const SIDE = { L: "Sol", R: "Sağ", both: "İki taraf" };
const MAX_BREAST_MS = 6 * HOUR;   // kurallarla aynı üst sınır
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
  let lastFeed = null, lastLoaded = false, dayEvents = [];
  let dayStart = startOfDay(Date.now()), followToday = true;
  const members = new Map(); // uid -> e-posta (baş harf için)
  let ticker = null;

  const uid = () => getUser()?.uid;
  const babyRef = () => doc(db, "spaces", sid, "babies", bid);
  const evCol = () => collection(db, "spaces", sid, "babies", bid, "events");
  const evRef = (id) => doc(db, "spaces", sid, "babies", bid, "events", id);
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

  function startEvents() {
    lastLoaded = false;
    lastUnsub = onSnapshot(query(evCol(), orderBy("at", "desc"), limit(1)), (snap) => {
      lastFeed = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
      lastLoaded = true;
      syncNextFeed(); render();
    }, (e) => dbg("son beslenme HATA: " + (e.code || e.message)));
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
    lastFeed = null; lastLoaded = false; dayEvents = [];
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
    frag.append(actionsRow(), dayNav(), timeline());
    root.replaceChildren(frag);
  }

  function dayTotals() {
    const t = { count: 0, bottles: 0, breasts: 0, ml: 0, breastMs: 0 };
    for (const ev of dayEvents) {
      t.count++;
      if (ev.method === "bottle") { t.bottles++; t.ml += ev.ml || 0; }
      else { t.breasts++; t.breastMs += Math.max(0, (ev.endAt || ev.at) - ev.at); }
    }
    return t;
  }

  function reminderText() {
    const h = baby.feedReminderHours || 0;
    if (!h) return "⏰ Hatırlatma kapalı — açmak için dokun";
    if (baby.activeTimer) return `⏰ Emzirme bitince ${h} saatlik hatırlatma kurulur`;
    if (!lastFeed) return `⏰ Hatırlatma: ilk beslenmeden ${h} saat sonra`;
    const next = lastFeed.at + h * HOUR;
    return next > Date.now() ? `⏰ Sonraki hatırlatma ${hhmm(next)} (${h} saat)` : `⏰ Beslenme zamanı geçti (${hhmm(next)})`;
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
    c.append(btn("bb-remind", reminderText(), openSettings));
    return c;
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
      desc.append(el("div", null, feedText(ev)));
      if (ev.note) desc.append(el("div", "bb-note", ev.note));
      li.append(desc);
      if (members.size > 1 && ev.by) {
        const chip = el("span", "who-chip", initial(ev.by));
        chip.style.background = personColor(ev.by);
        chip.title = members.get(ev.by) || "";
        li.append(chip);
      }
      li.addEventListener("click", () => (ev.method === "bottle" ? openBottle(ev) : openBreastManual(ev)));
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
    [[0, "Kapalı"], [3, "3 saat"], [4, "4 saat"]].forEach(([v, t]) => { const b = btn("", t); b.dataset.v = v; seg.append(b); });
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
        <div class="bb-seg" id="s-rem"><button type="button" data-v="0">Kapalı</button><button type="button" data-v="3">3 saat</button><button type="button" data-v="4">4 saat</button></div>
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
