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

/* ---------- Firebase ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ---------- Yardımcılar ---------- */
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

/* ---------- Durum ---------- */
let currentUser = null;
let userDocUnsub = null;
let creatingSpace = false;

let spaceId = null;          // aktif ortak alan
let spaceData = null;        // { ownerUid, inviteCode }
let spaceDocUnsub = null;
let listsUnsub = null;
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
  // eski alanın aboneliklerini kapat
  if (spaceDocUnsub) { spaceDocUnsub(); spaceDocUnsub = null; }
  if (listsUnsub) { listsUnsub(); listsUnsub = null; }
  if (todosUnsub) { todosUnsub(); todosUnsub = null; }
  lists.clear(); currentTodos = []; spaceData = null;
  $("todo-list").innerHTML = ""; $("lists-ul").innerHTML = "";

  spaceId = newSpaceId;
  activeListId = localStorage.getItem("active:" + spaceId) || null;

  // alan belgesi (davet kodu vb.)
  spaceDocUnsub = onSnapshot(doc(db, "spaces", spaceId), (d) => {
    spaceData = d.exists() ? d.data() : null;
  }, () => {});

  // listeler (anlık)
  const q = query(collection(db, "spaces", spaceId, "lists"), orderBy("createdAt"));
  listsUnsub = onSnapshot(q, (snap) => {
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
  }, () => {});
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
  $("list-title").textContent = l ? l.title : "Görevler";
}

function renderLists() {
  const ul = $("lists-ul");
  ul.innerHTML = "";
  [...lists.values()].forEach((l) => {
    const li = document.createElement("li");
    li.className = "list-row" + (l.id === activeListId ? " active" : "");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = l.title || "(başlıksız)";
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
  $("todo-list").innerHTML = "";
  if (!listId) { updateEmptyStates(); return; }

  const q = query(collection(db, "spaces", spaceId, "lists", listId, "todos"), orderBy("order"));
  todosUnsub = onSnapshot(q, (snap) => {
    currentTodos = [];
    snap.forEach((d) => currentTodos.push({ id: d.id, ...d.data() }));
    renderTodos();
    updateEmptyStates();
  }, () => {});
}

function renderTodos() {
  const ul = $("todo-list");
  ul.innerHTML = "";
  currentTodos.forEach((t) => ul.appendChild(todoRow(t)));

  if (sortable) { sortable.destroy(); sortable = null; }
  if (currentTodos.length > 1 && typeof Sortable !== "undefined") {
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

  const span = document.createElement("span");
  span.className = "todo-text";
  span.textContent = t.text;
  span.addEventListener("click", () => toggleTodo(t));

  const edit = document.createElement("button");
  edit.className = "row-del";
  edit.setAttribute("aria-label", "Düzenle");
  edit.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  edit.addEventListener("click", (e) => { e.stopPropagation(); startEdit(li, t); });

  const del = document.createElement("button");
  del.className = "row-del";
  del.setAttribute("aria-label", "Sil");
  del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteTodo(t); });

  li.append(cb, span, edit, del);
  return li;
}

function todoRef(id) { return doc(db, "spaces", spaceId, "lists", activeListId, "todos", id); }

async function addTodo(text) {
  if (!activeListId) return;
  const col = collection(db, "spaces", spaceId, "lists", activeListId, "todos");
  await addDoc(col, { text, done: false, order: Date.now(), createdAt: serverTimestamp(), createdBy: currentUser.uid }).catch(() => {});
  const scroll = $("todo-scroll");
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

function toggleTodo(t) {
  if (navigator.vibrate) navigator.vibrate(8);
  updateDoc(todoRef(t.id), { done: !t.done }).catch(() => {});
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
    if (val && val !== t.text) await updateDoc(todoRef(t.id), { text: val }).catch(() => {});
    else renderTodos();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { finished = true; renderTodos(); }
  });
  input.addEventListener("blur", save);
}

function deleteTodo(t) {
  const data = { text: t.text, done: !!t.done, order: t.order, createdAt: t.createdAt || serverTimestamp(), createdBy: t.createdBy || currentUser.uid };
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
    bodyHTML: '<input id="m-listname" type="text" placeholder="Liste adı (ör. Alışveriş)" />',
    okText: "Oluştur",
    onOk: async () => {
      const name = $("m-listname").value.trim();
      if (!name) return false;
      if (!spaceId) { modalError("Alan hazırlanıyor, bir saniye…"); return false; }
      const ref = await addDoc(collection(db, "spaces", spaceId, "lists"),
        { title: name, createdAt: serverTimestamp(), createdBy: currentUser.uid }).catch(() => null);
      if (!ref) { modalError("Oluşturulamadı. İnternetini kontrol et."); return false; }
      setActiveList(ref.id);
    }
  });
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
    const inv = await getDoc(doc(db, "invites", code));
    if (!inv.exists()) return "Kod bulunamadı. Kontrol et.";
    const newSpaceId = inv.data().spaceId;
    if (newSpaceId === spaceId) return "Zaten bu alandasınız.";
    const batch = writeBatch(db);
    batch.set(doc(db, "spaces", newSpaceId, "members", currentUser.uid), { email: currentUser.email || "", joinedAt: serverTimestamp() });
    batch.update(doc(db, "users", currentUser.uid), { spaceId: newSpaceId });
    if (spaceId) batch.delete(doc(db, "spaces", spaceId, "members", currentUser.uid));
    await batch.commit();
    return null;
  } catch (e) {
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
    await batch.commit();
    return true;
  } catch (e) { return false; }
}

/* ---- Menü: başlığı değiştir ---- */
$("mi-rename").addEventListener("click", () => {
  closeMenu();
  const l = lists.get(activeListId);
  openModal({
    title: "Başlığı değiştir",
    bodyHTML: `<input id="m-rename" type="text" value="${escapeAttr(l?.title || "")}" />`,
    okText: "Kaydet",
    onOk: async () => {
      const val = $("m-rename").value.trim();
      if (!val) return false;
      await updateDoc(doc(db, "spaces", spaceId, "lists", activeListId), { title: val }).catch(() => {});
    }
  });
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
  if (listsUnsub) { listsUnsub(); listsUnsub = null; }
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
