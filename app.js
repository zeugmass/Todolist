import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- Firebase kurulum ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ---------- Kısa yardımcılar ---------- */
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

/* ---------- Durum ---------- */
let currentUser = null;
let activeListId = localStorage.getItem("activeListId") || null;

let membershipUnsub = null;
const listDocUnsubs = new Map();   // listId -> unsub
const listData = new Map();        // listId -> { title, ownerUid, inviteCode }
let todosUnsub = null;
let currentTodos = [];             // aktif listedeki görevler
let sortable = null;

/* ================================================================
   KİMLİK DOĞRULAMA (Giriş / Üye ol)
================================================================ */
let authMode = "login"; // "login" | "signup"

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
    if (authMode === "signup") {
      await createUserWithEmailAndPassword(auth, email, pass);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
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
    startMemberships();
  } else {
    cleanupAll();
    hide($("screen-loading")); hide($("screen-main"));
    show($("screen-auth"));
  }
});

$("btn-signout").addEventListener("click", async () => {
  closeDrawer();
  await signOut(auth);
});

/* ================================================================
   LİSTELER (üyelikler → liste belgeleri)
================================================================ */
function startMemberships() {
  if (membershipUnsub) return;
  const ref = collection(db, "users", currentUser.uid, "memberships");
  membershipUnsub = onSnapshot(ref, (snap) => {
    const ids = new Set();
    snap.forEach((d) => ids.add(d.id));

    // yeni üyelikler → liste belgesine abone ol
    ids.forEach((id) => {
      if (!listDocUnsubs.has(id)) subscribeListDoc(id);
    });
    // kaldırılan üyelikler → aboneliği bırak
    for (const id of [...listDocUnsubs.keys()]) {
      if (!ids.has(id)) {
        listDocUnsubs.get(id)();
        listDocUnsubs.delete(id);
        listData.delete(id);
      }
    }
    // aktif liste hâlâ geçerli mi?
    if (ids.size === 0) {
      setActiveList(null);
    } else if (!activeListId || !ids.has(activeListId)) {
      setActiveList([...ids][0]);
    }
    renderLists();
    updateMainEmptyStates();
  });
}

function subscribeListDoc(listId) {
  const unsub = onSnapshot(
    doc(db, "lists", listId),
    (d) => {
      if (!d.exists()) {
        // Liste silinmiş → bayat üyelik işaretçisini temizle (kendi kendini onarır)
        deleteDoc(doc(db, "users", currentUser.uid, "memberships", listId)).catch(() => {});
        return;
      }
      listData.set(listId, d.data());
      renderLists();
      if (listId === activeListId) renderHeader();
    },
    () => { /* izin/ağ hatası: sessiz geç */ }
  );
  listDocUnsubs.set(listId, unsub);
}

function setActiveList(listId) {
  if (activeListId === listId) { if (listId) subscribeTodos(listId); return; }
  activeListId = listId;
  if (listId) localStorage.setItem("activeListId", listId);
  else localStorage.removeItem("activeListId");
  renderHeader();
  renderLists();
  subscribeTodos(listId);
  updateMainEmptyStates();
}

function renderHeader() {
  const data = activeListId ? listData.get(activeListId) : null;
  $("list-title").textContent = data ? data.title : "Görevler";
}

function renderLists() {
  const ul = $("lists-ul");
  ul.innerHTML = "";
  const ids = [...listData.keys()].sort((a, b) =>
    (listData.get(a).title || "").localeCompare(listData.get(b).title || "", "tr"));
  ids.forEach((id) => {
    const li = document.createElement("li");
    li.className = "list-row" + (id === activeListId ? " active" : "");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = listData.get(id).title || "(başlıksız)";
    li.appendChild(name);
    li.addEventListener("click", () => { setActiveList(id); closeDrawer(); });
    ul.appendChild(li);
  });
}

function updateMainEmptyStates() {
  const hasList = listData.size > 0;
  $("no-list-state").classList.toggle("hidden", hasList);
  $("add-form").classList.toggle("hidden", !hasList);
  if (!hasList) hide($("empty-state"));
}

/* ================================================================
   GÖREVLER (aktif liste)
================================================================ */
function subscribeTodos(listId) {
  if (todosUnsub) { todosUnsub(); todosUnsub = null; }
  currentTodos = [];
  $("todo-list").innerHTML = "";
  if (!listId) { hide($("empty-state")); return; }

  const q = query(collection(db, "lists", listId, "todos"), orderBy("order"));
  todosUnsub = onSnapshot(q, (snap) => {
    currentTodos = [];
    snap.forEach((d) => currentTodos.push({ id: d.id, ...d.data() }));
    renderTodos();
  }, () => {});
}

function renderTodos() {
  const ul = $("todo-list");
  ul.innerHTML = "";
  currentTodos.forEach((t) => ul.appendChild(todoRow(t)));

  const hasList = listData.size > 0;
  $("empty-state").classList.toggle("hidden", !(hasList && currentTodos.length === 0));

  // sürükle-sırala
  if (sortable) { sortable.destroy(); sortable = null; }
  if (currentTodos.length > 1) {
    sortable = Sortable.create(ul, {
      animation: 150,
      delay: 200,
      delayOnTouchOnly: true,
      ghostClass: "sortable-ghost",
      onEnd: onReorder
    });
  }
}

function todoRow(t) {
  const li = document.createElement("li");
  li.className = "todo-item" + (t.done ? " done" : "");
  li.dataset.id = t.id;

  // checkbox
  const cb = document.createElement("button");
  cb.className = "checkbox";
  cb.setAttribute("aria-label", "Tamamlandı");
  cb.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 13l4 4L19 7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  cb.querySelector("path").setAttribute("stroke", "var(--accent-contrast)");
  cb.addEventListener("click", (e) => { e.stopPropagation(); toggleTodo(t); });

  // metin
  const span = document.createElement("span");
  span.className = "todo-text";
  span.textContent = t.text;
  span.addEventListener("click", () => toggleTodo(t));

  // düzenle
  const edit = document.createElement("button");
  edit.className = "row-del";
  edit.setAttribute("aria-label", "Düzenle");
  edit.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  edit.addEventListener("click", (e) => { e.stopPropagation(); startEdit(li, t); });

  // sil
  const del = document.createElement("button");
  del.className = "row-del";
  del.setAttribute("aria-label", "Sil");
  del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteTodo(t); });

  li.append(cb, span, edit, del);
  return li;
}

async function addTodo(text) {
  if (!activeListId) return;
  const col = collection(db, "lists", activeListId, "todos");
  await addDoc(col, {
    text, done: false, order: Date.now(),
    createdAt: serverTimestamp(), createdBy: currentUser.uid
  });
  const scroll = $("todo-scroll");
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

function toggleTodo(t) {
  if (navigator.vibrate) navigator.vibrate(8);
  updateDoc(doc(db, "lists", activeListId, "todos", t.id), { done: !t.done }).catch(() => {});
}

function startEdit(li, t) {
  if (li.querySelector(".todo-edit")) return;
  const span = li.querySelector(".todo-text");
  const input = document.createElement("input");
  input.className = "todo-edit";
  input.value = t.text;
  li.replaceChild(input, span);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let finished = false;
  const save = async () => {
    if (finished) return; finished = true;
    const val = input.value.trim();
    if (val && val !== t.text) {
      await updateDoc(doc(db, "lists", activeListId, "todos", t.id), { text: val }).catch(() => {});
    } else {
      renderTodos();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { finished = true; renderTodos(); }
  });
  input.addEventListener("blur", save);
}

/* silme + geri al */
let undoTimer = null;
function deleteTodo(t) {
  const data = { text: t.text, done: !!t.done, order: t.order, createdAt: t.createdAt || serverTimestamp(), createdBy: t.createdBy || currentUser.uid };
  const id = t.id, listId = activeListId;
  deleteDoc(doc(db, "lists", listId, "todos", id)).catch(() => {});
  showSnackbar("Görev silindi", async () => {
    await setDoc(doc(db, "lists", listId, "todos", id), data).catch(() => {});
  });
}

async function onReorder() {
  const ul = $("todo-list");
  const ids = [...ul.querySelectorAll(".todo-item")].map((li) => li.dataset.id);
  const batch = writeBatch(db);
  ids.forEach((id, i) => batch.update(doc(db, "lists", activeListId, "todos", id), { order: i }));
  await batch.commit().catch(() => {});
}

/* ekleme formu */
$("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("add-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addTodo(text);
});

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

/* Modal yardımcıları */
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
  ok.addEventListener("click", async () => { const keep = await (onOk ? onOk() : null); if (keep !== false) closeModal(); });
  actions.appendChild(ok);
  show($("modal-overlay"));
  const firstInput = $("modal-body").querySelector("input");
  if (firstInput) {
    setTimeout(() => firstInput.focus(), 50);
    firstInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); ok.click(); }
    });
  }
}
function closeModal() { hide($("modal-overlay")); $("modal-body").innerHTML = ""; }
$("modal-overlay").addEventListener("click", (e) => { if (e.target === $("modal-overlay")) closeModal(); });

/* ---- Yeni liste ---- */
$("btn-new-list").addEventListener("click", () => {
  closeDrawer();
  openModal({
    title: "Yeni liste",
    bodyHTML: '<input id="m-listname" type="text" placeholder="Liste adı (ör. Alışveriş)" />',
    okText: "Oluştur",
    onOk: async () => {
      const name = $("m-listname").value.trim();
      if (!name) return false;
      await createList(name);
    }
  });
});

async function createList(title) {
  const listRef = doc(collection(db, "lists"));
  const listId = listRef.id;
  const code = genCode();
  const batch = writeBatch(db);
  batch.set(listRef, { title, ownerUid: currentUser.uid, inviteCode: code, createdAt: serverTimestamp() });
  batch.set(doc(db, "lists", listId, "members", currentUser.uid), { email: currentUser.email || "", joinedAt: serverTimestamp() });
  batch.set(doc(db, "invites", code), { listId, createdAt: serverTimestamp() });
  batch.set(doc(db, "users", currentUser.uid, "memberships", listId), { createdAt: serverTimestamp() });
  await batch.commit();
  setActiveList(listId);
}

/* ---- Listeye katıl ---- */
$("btn-join-list").addEventListener("click", () => {
  closeDrawer();
  openModal({
    title: "Listeye katıl",
    bodyHTML: '<input id="m-code" type="text" inputmode="text" autocapitalize="characters" placeholder="Davet kodu" style="text-transform:uppercase;letter-spacing:2px;text-align:center;font-size:20px" /><p class="hint">Eşinden aldığın davet kodunu gir.</p>',
    okText: "Katıl",
    onOk: async () => {
      const code = $("m-code").value.trim().toUpperCase();
      if (!code) return false;
      const err = await joinList(code);
      if (err) {
        let el = $("modal-body").querySelector(".err");
        if (!el) { el = document.createElement("p"); el.className = "hint err"; el.style.color = "var(--danger)"; $("modal-body").appendChild(el); }
        el.textContent = err;
        return false;
      }
    }
  });
});

async function joinList(code) {
  try {
    const inv = await getDoc(doc(db, "invites", code));
    if (!inv.exists()) return "Kod bulunamadı. Kontrol et.";
    const listId = inv.data().listId;
    const mine = await getDoc(doc(db, "users", currentUser.uid, "memberships", listId));
    if (mine.exists()) { setActiveList(listId); return null; }
    const batch = writeBatch(db);
    batch.set(doc(db, "lists", listId, "members", currentUser.uid), { email: currentUser.email || "", joinedAt: serverTimestamp() });
    batch.set(doc(db, "users", currentUser.uid, "memberships", listId), { createdAt: serverTimestamp() });
    await batch.commit();
    setActiveList(listId);
    return null;
  } catch (e) {
    return "Katılınamadı. İnternetini kontrol et.";
  }
}

/* ---- Menü: başlığı değiştir ---- */
$("mi-rename").addEventListener("click", () => {
  closeMenu();
  const data = listData.get(activeListId);
  openModal({
    title: "Başlığı değiştir",
    bodyHTML: `<input id="m-rename" type="text" value="${escapeAttr(data?.title || "")}" />`,
    okText: "Kaydet",
    onOk: async () => {
      const val = $("m-rename").value.trim();
      if (!val) return false;
      await updateDoc(doc(db, "lists", activeListId), { title: val }).catch(() => {});
    }
  });
});
// başlığa dokununca da düzenle
$("list-title").addEventListener("click", () => { if (activeListId) $("mi-rename").click(); });

/* ---- Menü: davet kodu ---- */
$("mi-invite").addEventListener("click", () => {
  closeMenu();
  const data = listData.get(activeListId);
  const code = data?.inviteCode || "—";
  openModal({
    title: "Davet kodu",
    bodyHTML: `<div class="invite-code" id="m-invite">${code}</div><p class="hint">Bu kodu eşine gönder. O da uygulamada <b>“Listeye katıl”</b> deyip bu kodu girsin.</p>`,
    okText: "Kopyala",
    showCancel: true,
    onOk: async () => {
      try { await navigator.clipboard.writeText(code); } catch {}
      const ok = $("modal-actions").querySelector(".ok");
      if (ok) ok.textContent = "Kopyalandı ✓";
      return false; // modalı açık tut
    }
  });
});

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
      done.forEach((t) => batch.delete(doc(db, "lists", activeListId, "todos", t.id)));
      await batch.commit().catch(() => {});
    }
  });
});

/* ---- Menü: listeden ayrıl / sil ---- */
$("mi-leave").addEventListener("click", async () => {
  closeMenu();
  const data = listData.get(activeListId);
  const isowner = data?.ownerUid === currentUser.uid;
  openModal({
    title: isowner ? "Listeyi sil" : "Listeden ayrıl",
    bodyHTML: `<p class="hint">${isowner
      ? "Bu liste ve içindeki tüm görevler kalıcı olarak silinecek (eşin için de). Emin misin?"
      : "Bu listeden ayrılacaksın. Sahibi listeyi tutmaya devam eder. Emin misin?"}</p>`,
    okText: isowner ? "Sil" : "Ayrıl", okDanger: true,
    onOk: async () => {
      const listId = activeListId;
      if (isowner) await deleteEntireList(listId);
      else await leaveList(listId);
    }
  });
});

async function deleteEntireList(listId) {
  const data = listData.get(listId);
  try {
    const todosSnap = await getDocs(collection(db, "lists", listId, "todos"));
    const batch = writeBatch(db);
    todosSnap.forEach((d) => batch.delete(doc(db, "lists", listId, "todos", d.id)));
    batch.delete(doc(db, "lists", listId, "members", currentUser.uid));
    if (data?.inviteCode) batch.delete(doc(db, "invites", data.inviteCode));
    batch.delete(doc(db, "lists", listId));
    batch.delete(doc(db, "users", currentUser.uid, "memberships", listId));
    await batch.commit();
  } catch (e) {
    toast("Silinemedi. Tekrar dene.");
  }
}

async function leaveList(listId) {
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "lists", listId, "members", currentUser.uid));
    batch.delete(doc(db, "users", currentUser.uid, "memberships", listId));
    await batch.commit();
  } catch (e) {
    toast("Ayrılınamadı. Tekrar dene.");
  }
}

/* ================================================================
   SNACKBAR / TOAST
================================================================ */
function showSnackbar(text, onUndo) {
  clearTimeout(undoTimer);
  $("snackbar-text").textContent = text;
  const btn = $("snackbar-action");
  show($("snackbar-action"));
  show($("snackbar"));
  const handler = () => { hide($("snackbar")); clearTimeout(undoTimer); onUndo && onUndo(); };
  btn.onclick = handler;
  undoTimer = setTimeout(() => hide($("snackbar")), 5000);
}
function toast(text) {
  clearTimeout(undoTimer);
  $("snackbar-text").textContent = text;
  hide($("snackbar-action"));
  show($("snackbar"));
  undoTimer = setTimeout(() => hide($("snackbar")), 2500);
}

/* ================================================================
   TEMİZLİK / YARDIMCI
================================================================ */
function cleanupAll() {
  if (membershipUnsub) { membershipUnsub(); membershipUnsub = null; }
  if (todosUnsub) { todosUnsub(); todosUnsub = null; }
  for (const un of listDocUnsubs.values()) un();
  listDocUnsubs.clear();
  listData.clear();
  currentTodos = [];
  if (sortable) { sortable.destroy(); sortable = null; }
  $("todo-list").innerHTML = "";
  $("lists-ul").innerHTML = "";
  renderHeader();
}

function genCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // karışabilenler (0,O,1,I,L) çıkarıldı
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function escapeAttr(s) { return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ================================================================
   SERVICE WORKER (PWA)
================================================================ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
