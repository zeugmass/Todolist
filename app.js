import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- Firebase ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// iOS/PWA'da güvenilir canlı senkron için: tek-sekme önbelleği + uzun-yoklama transportu.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({ forceOwnership: true }) }),
  experimentalForceLongPolling: true
});
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ---------- Yardımcılar ---------- */
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

/* ---------- Debug (?debug=1 ile ekran-üstü günlük) ---------- */
const DEBUG = new URLSearchParams(location.search).has("debug");
const t0 = performance.now();
let dbgEl = null;
function dbg(msg) {
  const line = `[+${((performance.now() - t0) / 1000).toFixed(2)}s] ${msg}`;
  try { console.log(line); } catch {}
  if (!DEBUG) return;
  if (!dbgEl) {
    dbgEl = document.createElement("div");
    dbgEl.style.cssText = "position:fixed;left:0;right:0;bottom:0;max-height:40vh;overflow:auto;background:rgba(0,0,0,.88);color:#31d158;font:11px/1.4 ui-monospace,monospace;padding:8px;z-index:99999;white-space:pre-wrap;border-top:2px solid #31d158";
    document.body.appendChild(dbgEl);
  }
  dbgEl.textContent += line + "\n";
  dbgEl.scrollTop = dbgEl.scrollHeight;
}
const ms = (t) => Math.round(performance.now() - t) + "ms";
dbg("uygulama başladı");

/* ---------- Özellik yardımcıları ---------- */
const LIST_EMOJIS = ["🛒","🍎","🧹","🏠","💊","🎁","📚","💼","🧺","🍽️","🛠️","🚗","✈️","🎉","📌","📝"];
let memberCount = 1;
let completedCollapsed = false;
function personColor(uid) { let h = 0; const s = uid || ""; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return `hsl(${h % 360} 55% 45%)`; }
function initialOf(email) { const e = (email || "?").trim(); return (e[0] || "?").toUpperCase(); }
function wireEmojiGrid() {
  const grid = $("m-emoji");
  if (!grid) return;
  grid.addEventListener("click", (e) => {
    const b = e.target.closest(".emoji-opt");
    if (!b) return;
    const already = b.classList.contains("sel");
    grid.querySelectorAll(".emoji-opt").forEach((x) => x.classList.remove("sel"));
    if (!already) b.classList.add("sel");
    grid.dataset.selected = already ? "" : b.dataset.e;
  });
}
function emojiGridHTML(selected) {
  return LIST_EMOJIS.map((e) => `<button type="button" class="emoji-opt${selected === e ? " sel" : ""}" data-e="${e}">${e}</button>`).join("");
}

/* ---------- Tarih / tekrar yardımcıları ---------- */
const REPEAT_OPTS = [["", "Tekrar yok"], ["daily", "Her gün"], ["weekdays", "Hafta içi (Pzt-Cum)"], ["weekly", "Her hafta"], ["monthly", "Her ay"]];
const REPEAT_LABEL = { daily: "Her gün", weekdays: "Hafta içi", weekly: "Her hafta", monthly: "Her ay" };
const AY = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

function formatDue(msv) {
  if (!msv) return null;
  const d = new Date(msv), now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDue = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startDue - startToday) / 86400000);
  const hasTime = d.getHours() || d.getMinutes();
  const hm = hasTime ? ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
  let label;
  if (dayDiff === 0) label = "Bugün" + hm;
  else if (dayDiff === 1) label = "Yarın" + hm;
  else if (dayDiff === -1) label = "Dün" + hm;
  else label = `${d.getDate()} ${AY[d.getMonth()]}` + hm;
  let cls = "upcoming";
  if (msv < now.getTime()) { cls = "overdue"; if (dayDiff !== 0) label = "⚠ " + label; }
  else if (dayDiff === 0) cls = "today";
  return { label, cls };
}
function nextDue(msv, repeat) {
  let d = new Date(msv || Date.now());
  const bump = () => {
    if (repeat === "weekly") d.setDate(d.getDate() + 7);
    else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
    else if (repeat === "weekdays") { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); }
    else d.setDate(d.getDate() + 1); // daily
  };
  bump();
  let guard = 0;
  while (d.getTime() <= Date.now() && guard++ < 500) bump();
  return d.getTime();
}
function msToLocalInput(msv) {
  if (!msv) return "";
  const d = new Date(msv - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
function localInputToMs(v) { return v ? new Date(v).getTime() : 0; }
function freqKey(text) { return text.trim().toLocaleLowerCase("tr").replace(/[\/#.\[\]$]/g, "_").slice(0, 120); }

let suggestions = [];

/* ---------- Durum ---------- */
let currentUser = null;
let userDocUnsub = null;
let creatingSpace = false;

let spaceId = null;          // aktif ortak alan
let spaceData = null;        // { ownerUid, inviteCode }
let spaceDocUnsub = null;
let membersUnsub = null;
let listsUnsub = null;
let frequentUnsub = null;
const lists = new Map();     // listId -> { title, createdAt, ... }
let activeListId = null;

let todosUnsub = null;
let currentTodos = [];
let sortable = null;
let undoTimer = null;

/* ================================================================
   KİMLİK DOĞRULAMA
================================================================ */
let authMode = "login";

$("pw-toggle").addEventListener("click", () => {
  const input = $("auth-password");
  const on = input.type === "password";
  input.type = on ? "text" : "password";
  $("pw-toggle").classList.toggle("on", on);
  $("pw-toggle").setAttribute("aria-label", on ? "Şifreyi gizle" : "Şifreyi göster");
});

$("auth-toggle").addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  const signup = authMode === "signup";
  $("auth-sub").textContent = signup ? "Yeni hesap oluştur" : "Devam etmek için giriş yap";
  $("auth-submit").textContent = signup ? "Üye ol" : "Giriş yap";
  $("auth-toggle").textContent = signup ? "Zaten hesabın var mı? Giriş yap" : "Hesabın yok mu? Üye ol";
  $("auth-password").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  hide($("auth-error"));
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const pass = $("auth-password").value;
  hide($("auth-error"));
  $("auth-submit").disabled = true;
  try {
    if (authMode === "signup") await createUserWithEmailAndPassword(auth, email, pass);
    else await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    $("auth-error").textContent = authErrorTR(err.code);
    show($("auth-error"));
  } finally {
    $("auth-submit").disabled = false;
  }
});

function authErrorTR(code) {
  switch (code) {
    case "auth/invalid-email": return "Geçersiz e-posta adresi.";
    case "auth/missing-password": return "Şifre gir.";
    case "auth/weak-password": return "Şifre en az 6 karakter olmalı.";
    case "auth/email-already-in-use": return "Bu e-posta zaten kayıtlı. Giriş yapmayı dene.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "E-posta veya şifre hatalı.";
    case "auth/too-many-requests": return "Çok fazla deneme. Biraz bekle.";
    case "auth/network-request-failed": return "İnternet bağlantısı yok.";
    default: return "Bir hata oluştu. Tekrar dene.";
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    $("user-email").textContent = user.email || "";
    hide($("screen-loading")); hide($("screen-auth"));
    show($("screen-main"));
    startUserDoc();
  } else {
    cleanupAll();
    hide($("screen-loading")); hide($("screen-main"));
    show($("screen-auth"));
  }
});

$("btn-signout").addEventListener("click", async () => { closeDrawer(); await signOut(auth); });

/* ================================================================
   KULLANICI BELGESİ → ORTAK ALAN (space)
   Her kullanıcı bir "space"e aittir. Aynı space'teki herkes
   tüm listeleri anlık görür.
================================================================ */
function startUserDoc() {
  if (userDocUnsub) return;
  userDocUnsub = onSnapshot(doc(db, "users", currentUser.uid), async (snap) => {
    const data = snap.data();
    if (!data || !data.spaceId) {
      if (!creatingSpace) { creatingSpace = true; await createPersonalSpace().catch(() => {}); creatingSpace = false; }
      return;
    }
    if (data.spaceId !== spaceId) switchToSpace(data.spaceId);
  }, () => {});
}

async function createPersonalSpace() {
  const spaceRef = doc(collection(db, "spaces"));
  const sid = spaceRef.id;
  const code = genCode();
  const batch = writeBatch(db);
  batch.set(spaceRef, { ownerUid: currentUser.uid, inviteCode: code, createdAt: serverTimestamp() });
  batch.set(doc(db, "spaces", sid, "members", currentUser.uid), { email: currentUser.email || "", joinedAt: serverTimestamp() });
  batch.set(doc(db, "invites", code), { spaceId: sid, createdAt: serverTimestamp() });
  batch.set(doc(db, "users", currentUser.uid), { spaceId: sid, email: currentUser.email || "" });
  await batch.commit();
}

function switchToSpace(newSpaceId) {
  if (!newSpaceId || newSpaceId === spaceId) return; // aynı alansa tekrar kurma
  dbg("alan değişiyor → " + newSpaceId.slice(0, 6));
  if (spaceDocUnsub) { spaceDocUnsub(); spaceDocUnsub = null; }
  if (membersUnsub) { membersUnsub(); membersUnsub = null; }
  if (listsUnsub) { listsUnsub(); listsUnsub = null; }
  if (frequentUnsub) { frequentUnsub(); frequentUnsub = null; }
  if (todosUnsub) { todosUnsub(); todosUnsub = null; }
  lists.clear(); currentTodos = []; spaceData = null; suggestions = [];
  $("todo-list").innerHTML = ""; $("lists-ul").innerHTML = "";
  setConnStatus(1); // yeni alan varsayılan: yalnız

  spaceId = newSpaceId;
  activeListId = localStorage.getItem("active:" + spaceId) || null;
  establishSpaceListeners();
}

// Alan seviyesindeki dinleyicileri (yeniden) kurar. Hata olursa kendini onarır.
function establishSpaceListeners() {
  if (!spaceId) return;
  if (spaceDocUnsub) { spaceDocUnsub(); spaceDocUnsub = null; }
  if (membersUnsub) { membersUnsub(); membersUnsub = null; }
  if (listsUnsub) { listsUnsub(); listsUnsub = null; }
  if (frequentUnsub) { frequentUnsub(); frequentUnsub = null; }

  spaceDocUnsub = onSnapshot(doc(db, "spaces", spaceId),
    (d) => { spaceData = d.exists() ? d.data() : null; },
    (e) => scheduleResync("alan " + (e.code || "")));

  // sık eklenenler (otomatik tamamlama önerileri)
  frequentUnsub = onSnapshot(query(collection(db, "spaces", spaceId, "frequent"), orderBy("count", "desc")),
    (snap) => { suggestions = []; snap.forEach((d) => suggestions.push(d.data())); },
    () => {});

  membersUnsub = onSnapshot(collection(db, "spaces", spaceId, "members"),
    (snap) => setConnStatus(snap.size),
    (e) => scheduleResync("üyeler " + (e.code || "")));

  const tSub = performance.now();
  let firstLists = true;
  const q = query(collection(db, "spaces", spaceId, "lists"), orderBy("createdAt"));
  listsUnsub = onSnapshot(q, (snap) => {
    if (firstLists) { dbg(`ilk liste anlık geldi ${ms(tSub)} (önbellek:${snap.metadata.fromCache}, adet:${snap.size})`); firstLists = false; }
    else dbg(`liste güncellendi (önbellek:${snap.metadata.fromCache}, adet:${snap.size})`);
    lists.clear();
    snap.forEach((d) => lists.set(d.id, { id: d.id, ...d.data() }));

    if (lists.size === 0) {
      setActiveList(null);
    } else if (!activeListId || !lists.has(activeListId)) {
      setActiveList([...lists.keys()][0]);
    } else {
      renderHeader();
      if (!todosUnsub) subscribeTodos(activeListId);
    }
    renderLists();
    updateEmptyStates();
  }, (e) => scheduleResync("listeler " + (e.code || "")));
}

// Hata sonrası otomatik yeniden bağlanma (sessiz ölmeyi engeller)
let resyncTimer = null;
function scheduleResync(reason) {
  dbg("otomatik yeniden bağlanma: " + reason);
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => { if (spaceId) { establishSpaceListeners(); subscribeTodos(activeListId); } }, 1500);
}

// Elle yenile (header'daki buton)
function manualResync() {
  dbg("elle yenile");
  if (spaceId) { establishSpaceListeners(); subscribeTodos(activeListId); }
  else if (currentUser) { startUserDoc(); }
  toast("Yenilendi");
}

function setActiveList(listId) {
  const changed = activeListId !== listId;
  activeListId = listId;
  if (listId) localStorage.setItem("active:" + spaceId, listId);
  else localStorage.removeItem("active:" + spaceId);
  renderHeader();
  renderLists();
  if (changed || !todosUnsub) subscribeTodos(listId);
  updateEmptyStates();
}

function renderHeader() {
  const l = activeListId ? lists.get(activeListId) : null;
  $("list-title").textContent = l ? ((l.emoji ? l.emoji + " " : "") + l.title) : "Görevler";
}

// Bağlantı durumu: 1 kişi = yalnız (buton gizli), 2+ = eşinle bağlı (buton görünür)
function setConnStatus(count) {
  const linked = count > 1;
  $("btn-disconnect").classList.toggle("hidden", !linked);
  const s = $("conn-status");
  s.textContent = linked ? `🔗 Eşinle bağlı (${count} kişi)` : "Yalnız kullanım";
  s.classList.toggle("linked", linked);
  if (count !== memberCount) { memberCount = count; if (spaceId) renderTodos(); }
}

function renderLists() {
  const ul = $("lists-ul");
  ul.innerHTML = "";
  [...lists.values()].forEach((l) => {
    const li = document.createElement("li");
    li.className = "list-row" + (l.id === activeListId ? " active" : "");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (l.emoji ? l.emoji + " " : "") + (l.title || "(başlıksız)");
    li.appendChild(name);
    li.addEventListener("click", () => { setActiveList(l.id); closeDrawer(); });
    ul.appendChild(li);
  });
}

function updateEmptyStates() {
  const hasList = lists.size > 0;
  $("no-list-state").classList.toggle("hidden", hasList);
  $("add-form").classList.toggle("hidden", !hasList);
  const noTodos = hasList && !!activeListId && currentTodos.length === 0;
  $("empty-state").classList.toggle("hidden", !noTodos);
}

/* ================================================================
   GÖREVLER
================================================================ */
function subscribeTodos(listId) {
  if (todosUnsub) { todosUnsub(); todosUnsub = null; }
  currentTodos = [];
  $("todo-list").innerHTML = ""; $("completed-list").innerHTML = "";
  $("completed-section").classList.add("hidden"); $("counter-bar").classList.add("hidden");
  if (!listId) { updateEmptyStates(); return; }

  const tSub = performance.now();
  let firstTodos = true;
  const q = query(collection(db, "spaces", spaceId, "lists", listId, "todos"), orderBy("order"));
  todosUnsub = onSnapshot(q, (snap) => {
    if (firstTodos) { dbg(`ilk görevler geldi ${ms(tSub)} (önbellek:${snap.metadata.fromCache}, adet:${snap.size})`); firstTodos = false; }
    else dbg(`görevler güncellendi (önbellek:${snap.metadata.fromCache}, adet:${snap.size})`);
    currentTodos = [];
    snap.forEach((d) => currentTodos.push({ id: d.id, ...d.data() }));
    renderTodos();
    updateEmptyStates();
  }, (e) => scheduleResync("görevler " + (e.code || "")));
}

function renderTodos() {
  const active = currentTodos.filter((t) => !t.done);
  const done = currentTodos.filter((t) => t.done);

  const ul = $("todo-list");
  ul.innerHTML = "";
  active.forEach((t) => ul.appendChild(todoRow(t)));

  const cl = $("completed-list");
  cl.innerHTML = "";
  done.forEach((t) => cl.appendChild(todoRow(t)));

  // Tamamlananlar bölümü
  $("completed-section").classList.toggle("hidden", done.length === 0);
  $("completed-header").textContent = `${completedCollapsed ? "▸" : "▾"} Tamamlananlar (${done.length})`;
  cl.classList.toggle("hidden", completedCollapsed);

  // Sayaç
  const cb = $("counter-bar");
  if (currentTodos.length > 0) {
    cb.classList.remove("hidden");
    cb.textContent = `${active.length} kaldı · ${done.length} tamamlandı`;
  } else cb.classList.add("hidden");

  // Sürükle-sırala yalnızca aktif görevlerde
  if (sortable) { sortable.destroy(); sortable = null; }
  if (active.length > 1 && typeof Sortable !== "undefined") {
    sortable = Sortable.create(ul, {
      animation: 150, delay: 200, delayOnTouchOnly: true,
      ghostClass: "sortable-ghost", onEnd: onReorder
    });
  }
}

function todoRow(t) {
  const li = document.createElement("li");
  li.className = "todo-item" + (t.done ? " done" : "");
  li.dataset.id = t.id;

  const cb = document.createElement("button");
  cb.className = "checkbox";
  cb.setAttribute("aria-label", "Tamamlandı");
  cb.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 13l4 4L19 7" fill="none" stroke="var(--accent-contrast)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  cb.addEventListener("click", (e) => { e.stopPropagation(); toggleTodo(t); });

  const wrap = document.createElement("div");
  wrap.className = "todo-text-wrap";
  const span = document.createElement("span");
  span.className = "todo-text";
  span.textContent = t.text;
  wrap.appendChild(span);

  const due = t.done ? null : formatDue(t.dueAt);
  if (t.note || due || t.repeat) {
    const meta = document.createElement("div");
    meta.className = "todo-meta";
    if (t.note) { const n = document.createElement("span"); n.className = "todo-note"; n.textContent = t.note; meta.appendChild(n); }
    if (due) { const p = document.createElement("span"); p.className = "due-pill " + due.cls; p.textContent = due.label; meta.appendChild(p); }
    if (t.repeat) { const r = document.createElement("span"); r.className = "repeat-badge"; r.textContent = "🔁 " + (REPEAT_LABEL[t.repeat] || ""); meta.appendChild(r); }
    wrap.appendChild(meta);
  }
  wrap.addEventListener("click", () => toggleTodo(t));

  li.append(cb, wrap);

  // Kim ekledi / kim tamamladı (yalnızca eşinle bağlıyken)
  if (memberCount > 1) {
    const email = t.done ? (t.doneByEmail || t.createdByEmail) : t.createdByEmail;
    const cuid = t.done ? (t.doneBy || t.createdBy) : t.createdBy;
    if (email) {
      const chip = document.createElement("span");
      chip.className = "who-chip";
      chip.textContent = initialOf(email);
      chip.style.background = personColor(cuid);
      chip.title = (t.done ? "Tamamlayan: " : "Ekleyen: ") + email;
      li.appendChild(chip);
    }
  }

  const edit = document.createElement("button");
  edit.className = "row-del";
  edit.setAttribute("aria-label", "Düzenle");
  edit.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  edit.addEventListener("click", (e) => { e.stopPropagation(); openTodoEditor(t); });

  const del = document.createElement("button");
  del.className = "row-del";
  del.setAttribute("aria-label", "Sil");
  del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteTodo(t); });

  li.append(edit, del);
  return li;
}

function todoRef(id) { return doc(db, "spaces", spaceId, "lists", activeListId, "todos", id); }

async function addTodo(text) {
  if (!activeListId) return;
  const col = collection(db, "spaces", spaceId, "lists", activeListId, "todos");
  await addDoc(col, { text, note: "", done: false, order: Date.now(), createdAt: serverTimestamp(), createdBy: currentUser.uid, createdByEmail: currentUser.email || "" }).catch(() => {});
  // sık eklenenler sayacını artır (öneriler için)
  const key = freqKey(text);
  if (key) setDoc(doc(db, "spaces", spaceId, "frequent", key), { text, count: increment(1), lastUsed: serverTimestamp() }, { merge: true }).catch(() => {});
  const scroll = $("todo-scroll");
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

function toggleTodo(t) {
  if (navigator.vibrate) navigator.vibrate(8);
  // Tekrarlayan görev: tamamlayınca silinmez/işaretlenmez, bir sonraki tarihe atlar
  if (!t.done && t.repeat) {
    const next = nextDue(t.dueAt, t.repeat);
    updateDoc(todoRef(t.id), { dueAt: next, done: false }).catch(() => {});
    const f = formatDue(next);
    toast("🔁 Tekrarlandı → " + (f ? f.label : ""));
    return;
  }
  const nowDone = !t.done;
  const upd = { done: nowDone };
  if (nowDone) { upd.doneBy = currentUser.uid; upd.doneByEmail = currentUser.email || ""; upd.doneAt = serverTimestamp(); }
  updateDoc(todoRef(t.id), upd).catch(() => {});
}

function openTodoEditor(t) {
  const opts = REPEAT_OPTS.map(([v, l]) => `<option value="${v}"${(t.repeat || "") === v ? " selected" : ""}>${l}</option>`).join("");
  openModal({
    title: "Görevi düzenle",
    bodyHTML: `<input id="e-text" type="text" value="${escapeAttr(t.text)}" placeholder="Görev" />
      <input id="e-note" type="text" placeholder="Miktar / not (isteğe bağlı)" value="${escapeAttr(t.note || "")}" />
      <div class="field-label">Son tarih (isteğe bağlı)</div>
      <input id="e-due" type="datetime-local" value="${msToLocalInput(t.dueAt)}" />
      <div class="field-label">Tekrar</div>
      <select id="e-repeat">${opts}</select>`,
    okText: "Kaydet",
    onOk: async () => {
      const text = $("e-text").value.trim();
      if (!text) return false;
      const note = $("e-note").value.trim();
      const dueAt = localInputToMs($("e-due").value);
      const repeat = $("e-repeat").value;
      await updateDoc(todoRef(t.id), { text, note, dueAt, repeat }).catch(() => {});
    }
  });
}

function deleteTodo(t) {
  const data = { text: t.text, note: t.note || "", done: !!t.done, order: t.order, createdAt: t.createdAt || serverTimestamp(), createdBy: t.createdBy || currentUser.uid, createdByEmail: t.createdByEmail || "" };
  if (t.dueAt) data.dueAt = t.dueAt;
  if (t.repeat) data.repeat = t.repeat;
  if (t.doneBy) { data.doneBy = t.doneBy; data.doneByEmail = t.doneByEmail || ""; }
  const id = t.id, sid = spaceId, lid = activeListId;
  deleteDoc(doc(db, "spaces", sid, "lists", lid, "todos", id)).catch(() => {});
  showSnackbar("Görev silindi", async () => {
    await setDoc(doc(db, "spaces", sid, "lists", lid, "todos", id), data).catch(() => {});
  });
}

async function onReorder() {
  const ul = $("todo-list");
  const ids = [...ul.querySelectorAll(".todo-item")].map((li) => li.dataset.id);
  const batch = writeBatch(db);
  ids.forEach((id, i) => batch.update(todoRef(id), { order: i }));
  await batch.commit().catch(() => {});
}

$("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("add-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  hideSuggest();
  addTodo(text);
});

/* Otomatik tamamlama (sık eklenenler) */
function hideSuggest() { $("suggest-box").classList.add("hidden"); }
function renderSuggestions() {
  const box = $("suggest-box");
  const qv = $("add-input").value.trim().toLocaleLowerCase("tr");
  if (!qv) { hideSuggest(); return; }
  const active = new Set(currentTodos.filter((t) => !t.done).map((t) => t.text.toLocaleLowerCase("tr")));
  const matches = suggestions
    .filter((s) => s.text && s.text.toLocaleLowerCase("tr").startsWith(qv) && s.text.toLocaleLowerCase("tr") !== qv && !active.has(s.text.toLocaleLowerCase("tr")))
    .slice(0, 6);
  if (matches.length === 0) { hideSuggest(); return; }
  box.innerHTML = "";
  matches.forEach((s) => {
    const it = document.createElement("div");
    it.className = "suggest-item";
    it.innerHTML = `<span class="s-plus">+</span><span>${escapeHtml(s.text)}</span>`;
    it.addEventListener("mousedown", (ev) => ev.preventDefault()); // input blur'ünü engelle
    it.addEventListener("click", () => { addTodo(s.text); $("add-input").value = ""; hideSuggest(); $("add-input").focus(); });
    box.appendChild(it);
  });
  box.classList.remove("hidden");
}
$("add-input").addEventListener("input", renderSuggestions);
$("add-input").addEventListener("focus", renderSuggestions);
$("add-input").addEventListener("blur", () => setTimeout(hideSuggest, 150));

/* ================================================================
   ÇEKMECE + MENÜ + MODAL
================================================================ */
function openDrawer() { show($("drawer-overlay")); $("drawer").classList.add("open"); }
function closeDrawer() { hide($("drawer-overlay")); $("drawer").classList.remove("open"); }
$("btn-lists").addEventListener("click", openDrawer);
$("drawer-close").addEventListener("click", closeDrawer);
$("drawer-overlay").addEventListener("click", closeDrawer);

function openMenu() { show($("menu-overlay")); show($("list-menu")); }
function closeMenu() { hide($("menu-overlay")); hide($("list-menu")); }
$("btn-menu").addEventListener("click", () => { if (activeListId) openMenu(); });
$("menu-overlay").addEventListener("click", closeMenu);
$("btn-refresh").addEventListener("click", () => {
  const b = $("btn-refresh");
  b.classList.add("spinning");
  manualResync();
  setTimeout(() => b.classList.remove("spinning"), 700);
});
$("completed-header").addEventListener("click", () => { completedCollapsed = !completedCollapsed; renderTodos(); });

function openModal({ title, bodyHTML, okText = "Tamam", okDanger = false, onOk, showCancel = true }) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHTML || "";
  const actions = $("modal-actions");
  actions.innerHTML = "";
  if (showCancel) {
    const c = document.createElement("button");
    c.className = "cancel"; c.textContent = "İptal";
    c.addEventListener("click", closeModal);
    actions.appendChild(c);
  }
  const ok = document.createElement("button");
  ok.className = "ok" + (okDanger ? " danger" : ""); ok.textContent = okText;
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    let keep;
    try { keep = await (onOk ? onOk(ok) : null); }
    finally { ok.disabled = false; }
    if (keep !== false) closeModal();
  });
  actions.appendChild(ok);
  show($("modal-overlay"));
  const firstInput = $("modal-body").querySelector("input");
  if (firstInput) {
    setTimeout(() => firstInput.focus(), 50);
    firstInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
  }
}
function closeModal() { hide($("modal-overlay")); $("modal-body").innerHTML = ""; }
$("modal-overlay").addEventListener("click", (e) => { if (e.target === $("modal-overlay")) closeModal(); });

function modalError(msg) {
  let el = $("modal-body").querySelector(".err");
  if (!el) { el = document.createElement("p"); el.className = "hint err"; el.style.color = "var(--danger)"; $("modal-body").appendChild(el); }
  el.textContent = msg;
}

/* ---- Yeni liste ---- */
$("btn-new-list").addEventListener("click", () => {
  closeDrawer();
  openModal({
    title: "Yeni liste",
    bodyHTML: `<input id="m-listname" type="text" placeholder="Liste adı (ör. Alışveriş)" />
      <div class="emoji-label">Simge (isteğe bağlı)</div>
      <div id="m-emoji" class="emoji-grid" data-selected="">${emojiGridHTML("")}</div>`,
    okText: "Oluştur",
    onOk: async () => {
      const name = $("m-listname").value.trim();
      if (!name) return false;
      if (!spaceId) { modalError("Alan hazırlanıyor, bir saniye…"); return false; }
      const emoji = $("m-emoji").dataset.selected || "";
      const ref = await addDoc(collection(db, "spaces", spaceId, "lists"),
        { title: name, emoji, createdAt: serverTimestamp(), createdBy: currentUser.uid }).catch(() => null);
      if (!ref) { modalError("Oluşturulamadı. İnternetini kontrol et."); return false; }
      lists.set(ref.id, { id: ref.id, title: name, emoji, createdBy: currentUser.uid }); // anlık göster
      setActiveList(ref.id);
      renderLists(); updateEmptyStates();
    }
  });
  wireEmojiGrid();
});

/* ---- Eşini davet et (kod göster) ---- */
$("btn-invite").addEventListener("click", () => {
  closeDrawer();
  const code = spaceData?.inviteCode || "…";
  openModal({
    title: "Eşini davet et",
    bodyHTML: `<div class="invite-code" id="m-invite">${code}</div><p class="hint">Bu kodu eşine gönder. O da uygulamada <b>“Listeye katıl”</b> deyip bu kodu girsin. Bağlandıktan sonra <b>tüm listeleriniz</b> ikinizde de anlık görünür.</p>`,
    okText: "Kopyala",
    onOk: async (btn) => {
      try { await navigator.clipboard.writeText(code); btn.textContent = "Kopyalandı ✓"; }
      catch { btn.textContent = "Kopyalanamadı"; }
      return false;
    }
  });
});

/* ---- Listeye katıl (kod gir) ---- */
$("btn-join-list").addEventListener("click", () => {
  closeDrawer();
  openModal({
    title: "Listeye katıl",
    bodyHTML: '<input id="m-code" type="text" autocapitalize="characters" placeholder="Davet kodu" style="text-transform:uppercase;letter-spacing:3px;text-align:center;font-size:22px" /><p class="hint">Eşinden aldığın kodu gir. Katılınca onun tüm listelerini görürsün. (Kendi mevcut listelerin, sen tekrar kendi alanına dönene kadar görünmez olur.)</p>',
    okText: "Katıl",
    onOk: async (btn) => {
      const code = $("m-code").value.trim().toUpperCase();
      if (!code) return false;
      btn.textContent = "Katılınıyor…";
      const err = await joinSpace(code);
      if (err) { btn.textContent = "Katıl"; modalError(err); return false; }
      // başarılı: users belgesi güncellendi, snapshot alanı değiştirecek
    }
  });
});

async function joinSpace(code) {
  try {
    dbg("katıl: kod aranıyor…");
    const tGet = performance.now();
    const inv = await getDoc(doc(db, "invites", code));
    dbg(`katıl: kod arandı ${ms(tGet)} (bulundu:${inv.exists()})`);
    if (!inv.exists()) return "Kod bulunamadı. Kontrol et.";
    const newSpaceId = inv.data().spaceId;
    if (newSpaceId === spaceId) return "Zaten bu alandasınız.";
    const batch = writeBatch(db);
    batch.set(doc(db, "spaces", newSpaceId, "members", currentUser.uid), { email: currentUser.email || "", joinedAt: serverTimestamp() });
    batch.update(doc(db, "users", currentUser.uid), { spaceId: newSpaceId });
    if (spaceId) batch.delete(doc(db, "spaces", spaceId, "members", currentUser.uid));
    const tCommit = performance.now();
    await batch.commit();
    dbg(`katıl: yazıldı ${ms(tCommit)}`);
    switchToSpace(newSpaceId); // anlık: snapshot'ı bekleme
    return null;
  } catch (e) {
    dbg("katıl HATA: " + (e.code || e.message));
    return "Katılınamadı. İnternetini kontrol et.";
  }
}

/* ---- Bağlantıyı kes (kendi yeni alanına dön) ---- */
$("btn-disconnect").addEventListener("click", () => {
  closeDrawer();
  openModal({
    title: "Bağlantıyı kes",
    bodyHTML: '<p class="hint">Ortak alandan ayrılıp kendine ait yeni, boş bir alana geçeceksin. Eşin kendi alanında listeleri görmeye devam eder. Tekrar bağlanmak için yeniden davet kodu girmen gerekir.</p>',
    okText: "Bağlantıyı kes", okDanger: true,
    onOk: async () => {
      const ok = await disconnectSpace();
      if (!ok) { modalError("İşlem başarısız. Tekrar dene."); return false; }
    }
  });
});

async function disconnectSpace() {
  try {
    const spaceRef = doc(collection(db, "spaces"));
    const sid = spaceRef.id;
    const code = genCode();
    const batch = writeBatch(db);
    batch.set(spaceRef, { ownerUid: currentUser.uid, inviteCode: code, createdAt: serverTimestamp() });
    batch.set(doc(db, "spaces", sid, "members", currentUser.uid), { email: currentUser.email || "", joinedAt: serverTimestamp() });
    batch.set(doc(db, "invites", code), { spaceId: sid, createdAt: serverTimestamp() });
    batch.update(doc(db, "users", currentUser.uid), { spaceId: sid });
    if (spaceId) batch.delete(doc(db, "spaces", spaceId, "members", currentUser.uid));
    const tCommit = performance.now();
    await batch.commit();
    dbg(`bağlantı kesildi, yazıldı ${ms(tCommit)}`);
    switchToSpace(sid); // anlık: snapshot'ı bekleme
    return true;
  } catch (e) { dbg("bağlantı kes HATA: " + (e.code || e.message)); return false; }
}

/* ---- Menü: başlığı değiştir ---- */
$("mi-rename").addEventListener("click", () => {
  closeMenu();
  const l = lists.get(activeListId);
  openModal({
    title: "Listeyi düzenle",
    bodyHTML: `<input id="m-rename" type="text" value="${escapeAttr(l?.title || "")}" />
      <div class="emoji-label">Simge</div>
      <div id="m-emoji" class="emoji-grid" data-selected="${escapeAttr(l?.emoji || "")}">${emojiGridHTML(l?.emoji || "")}</div>`,
    okText: "Kaydet",
    onOk: async () => {
      const val = $("m-rename").value.trim();
      if (!val) return false;
      const emoji = $("m-emoji").dataset.selected || "";
      await updateDoc(doc(db, "spaces", spaceId, "lists", activeListId), { title: val, emoji }).catch(() => {});
    }
  });
  wireEmojiGrid();
});
$("list-title").addEventListener("click", () => { if (activeListId) $("mi-rename").click(); });

/* ---- Menü: tamamlananları temizle ---- */
$("mi-clear-done").addEventListener("click", () => {
  closeMenu();
  const done = currentTodos.filter((t) => t.done);
  if (done.length === 0) { toast("Tamamlanan görev yok."); return; }
  openModal({
    title: "Tamamlananları temizle",
    bodyHTML: `<p class="hint">${done.length} tamamlanmış görev silinecek. Emin misin?</p>`,
    okText: "Temizle", okDanger: true,
    onOk: async () => {
      const batch = writeBatch(db);
      done.forEach((t) => batch.delete(todoRef(t.id)));
      await batch.commit().catch(() => {});
    }
  });
});

/* ---- Menü: listeyi sil ---- */
$("mi-delete-list").addEventListener("click", () => {
  closeMenu();
  const l = lists.get(activeListId);
  openModal({
    title: "Listeyi sil",
    bodyHTML: `<p class="hint">“${escapeHtml(l?.title || "")}” listesi ve içindeki tüm görevler silinecek (eşin için de). Emin misin?</p>`,
    okText: "Sil", okDanger: true,
    onOk: async () => {
      const lid = activeListId;
      try {
        const todosSnap = await getDocs(collection(db, "spaces", spaceId, "lists", lid, "todos"));
        const batch = writeBatch(db);
        todosSnap.forEach((d) => batch.delete(doc(db, "spaces", spaceId, "lists", lid, "todos", d.id)));
        batch.delete(doc(db, "spaces", spaceId, "lists", lid));
        await batch.commit();
      } catch (e) { toast("Silinemedi. Tekrar dene."); }
    }
  });
});

/* ================================================================
   SNACKBAR
================================================================ */
function showSnackbar(text, onUndo) {
  clearTimeout(undoTimer);
  $("snackbar-text").textContent = text;
  show($("snackbar-action")); show($("snackbar"));
  $("snackbar-action").onclick = () => { hide($("snackbar")); clearTimeout(undoTimer); onUndo && onUndo(); };
  undoTimer = setTimeout(() => hide($("snackbar")), 5000);
}
function toast(text) {
  clearTimeout(undoTimer);
  $("snackbar-text").textContent = text;
  hide($("snackbar-action")); show($("snackbar"));
  undoTimer = setTimeout(() => hide($("snackbar")), 2500);
}

/* ================================================================
   TEMİZLİK / YARDIMCI
================================================================ */
function cleanupAll() {
  if (userDocUnsub) { userDocUnsub(); userDocUnsub = null; }
  if (spaceDocUnsub) { spaceDocUnsub(); spaceDocUnsub = null; }
  if (membersUnsub) { membersUnsub(); membersUnsub = null; }
  if (listsUnsub) { listsUnsub(); listsUnsub = null; }
  if (frequentUnsub) { frequentUnsub(); frequentUnsub = null; }
  if (todosUnsub) { todosUnsub(); todosUnsub = null; }
  if (sortable) { sortable.destroy(); sortable = null; }
  lists.clear(); currentTodos = []; spaceId = null; spaceData = null; activeListId = null;
  $("todo-list").innerHTML = ""; $("lists-ul").innerHTML = "";
  renderHeader();
}

function genCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function escapeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ================================================================
   SERVICE WORKER
================================================================ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}
