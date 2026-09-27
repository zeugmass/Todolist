// Bebek takibi kuralları — saldırı/doğrulama testleri (YALNIZ emülatör).
// Ayrı projectId: rules.test.mjs ile paralel çalışınca birbirinin verisini silmesin.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";

const A = "oBakqJgdSzbm6HL1JBWcGTsI1kJ2"; // izinli, ortak alan üyesi
const B = "7GBK0HeVh3cJyVrWanXUfnQHJTy2"; // izinli, ortak alan üyesi (eş)
const X = "attacker-uid-zz";              // izinsiz
const S = "sharedSpace", P = "personalA";
const NOW = Date.now(), MIN = 60000, H = 3600000;
const babyPath = (sid = S, bid = "b1") => ["spaces", sid, "babies", bid];
const evPath = (eid, sid = S, bid = "b1") => ["spaces", sid, "babies", bid, "events", eid];
const baby = (over = {}) => ({ name: "Minik", birthDate: "2026-10-01", createdBy: A, feedReminderHours: 3, tz: "Europe/Paris", ...over });
const bottle = (over = {}) => ({ type: "feed", method: "bottle", at: NOW - 10 * MIN, ml: 120, milk: "breast", by: A, tz: "Europe/Paris", ...over });
const breast = (over = {}) => ({ type: "feed", method: "breast", at: NOW - 30 * MIN, endAt: NOW - 15 * MIN, side: "L", by: A, ...over });

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-todo-baby",
    firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8") }
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "spaces", S), { ownerUid: A, shared: true });
    await setDoc(doc(db, "spaces", S, "members", A), { email: "a@x" });
    await setDoc(doc(db, "spaces", S, "members", B), { email: "b@x" });
    await setDoc(doc(db, "spaces", P), { ownerUid: A, shared: false });
    await setDoc(doc(db, "spaces", P, "members", A), { email: "a@x" });
    await setDoc(doc(db, ...babyPath()), baby());
    await setDoc(doc(db, ...babyPath(P, "pb")), baby());
    await setDoc(doc(db, ...evPath("e1")), bottle());
  });
});
const as = (uid) => env.authenticatedContext(uid).firestore();

// ── ERİŞİM ───────────────────────────────────────────────────────────────────
test("izinsiz hesap: üye kaydı olsa bile bebek verisini OKUYAMAZ", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "spaces", S, "members", X), { email: "x@x" }));
  await assertFails(getDoc(doc(as(X), ...babyPath())));
  await assertFails(getDoc(doc(as(X), ...evPath("e1"))));
  await assertFails(setDoc(doc(as(X), ...evPath("ex")), bottle({ by: X })));
});
test("üye olmayan (izinli) eş, kişisel alandaki bebek verisini okuyamaz", async () => {
  await assertFails(getDoc(doc(as(B), ...babyPath(P, "pb"))));
});
test("anonim: hiçbir bebek verisi okunamaz", async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), ...babyPath())));
});
test("üyeler: bebek ve günlük kayıt sorgusu okunur", async () => {
  await assertSucceeds(getDoc(doc(as(B), ...babyPath())));
  const q = query(collection(as(B), ...babyPath(), "events"), where("at", ">=", NOW - 24 * H), where("at", "<", NOW + H), orderBy("at", "desc"));
  await assertSucceeds(getDocs(q));
});

// ── BEBEK PROFİLİ ────────────────────────────────────────────────────────────
test("bebek oluşturma: geçerli ✓ / başkası adına ✗ / fazladan alan ✗", async () => {
  await assertSucceeds(setDoc(doc(as(A), ...babyPath(S, "b2")), baby()));
  await assertFails(setDoc(doc(as(A), ...babyPath(S, "b3")), baby({ createdBy: B })));
  await assertFails(setDoc(doc(as(A), ...babyPath(S, "b4")), baby({ gizli: 1 })));
});
test("bebek: boş ad / 41 karakter ad / hatırlatma 5 saat / bozuk doğum tarihi → RED", async () => {
  const db = as(A);
  await assertFails(setDoc(doc(db, ...babyPath(S, "c1")), baby({ name: "" })));
  await assertFails(setDoc(doc(db, ...babyPath(S, "c2")), baby({ name: "x".repeat(41) })));
  await assertFails(setDoc(doc(db, ...babyPath(S, "c3")), baby({ feedReminderHours: 5 })));
  await assertFails(setDoc(doc(db, ...babyPath(S, "c4")), baby({ birthDate: "01.10.2026" })));
  await assertSucceeds(setDoc(doc(db, ...babyPath(S, "c5")), baby({ birthDate: null, feedReminderHours: 0 })));
});
test("eş bebek belgesini günceller (hatırlatma zamanı) ✓; oluşturanı değiştiremez ✗", async () => {
  await assertSucceeds(updateDoc(doc(as(B), ...babyPath()), { nextFeedAt: NOW + 3 * H, lastFeedAt: NOW, feedReminderHours: 4 }));
  await assertFails(updateDoc(doc(as(B), ...babyPath()), { createdBy: B }));
});
test("emzirme sayacı: geçerli ✓ / geçersiz taraf ✗ / fazladan alan ✗", async () => {
  const db = as(B);
  await assertSucceeds(updateDoc(doc(db, ...babyPath()), { activeTimer: { kind: "breast", side: "L", startedAt: NOW, startedBy: B } }));
  await assertFails(updateDoc(doc(db, ...babyPath()), { activeTimer: { kind: "breast", side: "X", startedAt: NOW, startedBy: B } }));
  await assertFails(updateDoc(doc(db, ...babyPath()), { activeTimer: { kind: "breast", side: "R", startedAt: NOW, startedBy: B, x: 1 } }));
  await assertSucceeds(updateDoc(doc(db, ...babyPath()), { activeTimer: null }));
});

// ── BİBERON ──────────────────────────────────────────────────────────────────
test("biberon: geçerli ✓", async () => {
  await assertSucceeds(setDoc(doc(as(A), ...evPath("n1")), bottle()));
  await assertSucceeds(setDoc(doc(as(A), ...evPath("n2")), bottle({ milk: null, note: "kustu biraz" })));
});
test("biberon: 0 ml / 600 ml / metin ml / taraf var / bitiş var → RED", async () => {
  const db = as(A);
  await assertFails(setDoc(doc(db, ...evPath("x1")), bottle({ ml: 0 })));
  await assertFails(setDoc(doc(db, ...evPath("x2")), bottle({ ml: 600 })));
  await assertFails(setDoc(doc(db, ...evPath("x3")), bottle({ ml: "120" })));
  await assertFails(setDoc(doc(db, ...evPath("x4")), bottle({ side: "L" })));
  await assertFails(setDoc(doc(db, ...evPath("x5")), bottle({ endAt: NOW })));
  await assertFails(setDoc(doc(db, ...evPath("x6")), bottle({ milk: "su" })));
});

// ── EMZİRME ──────────────────────────────────────────────────────────────────
test("emzirme: geçerli (sol, 15 dk) ✓ ve ikisi ✓", async () => {
  await assertSucceeds(setDoc(doc(as(B), ...evPath("m1")), breast({ by: B })));
  await assertSucceeds(setDoc(doc(as(B), ...evPath("m2")), breast({ by: B, side: "both" })));
});
test("emzirme: bitiş yok / bitiş başlangıçtan önce / 6 saatten uzun / ml var → RED", async () => {
  const db = as(A);
  const { endAt, ...noEnd } = breast();
  await assertFails(setDoc(doc(db, ...evPath("y1")), noEnd));
  await assertFails(setDoc(doc(db, ...evPath("y2")), breast({ endAt: NOW - 40 * MIN })));
  await assertFails(setDoc(doc(db, ...evPath("y3")), breast({ at: NOW - 8 * H, endAt: NOW - MIN })));
  await assertFails(setDoc(doc(db, ...evPath("y4")), breast({ ml: 50 })));
});

// ── GENEL ALANLAR ────────────────────────────────────────────────────────────
test("zaman: 2 gün sonrası / 2019 → RED; not 200 ✓ / 201 ✗; bilinmeyen tür ✗", async () => {
  const db = as(A);
  await assertFails(setDoc(doc(db, ...evPath("z1")), bottle({ at: NOW + 48 * H })));
  await assertFails(setDoc(doc(db, ...evPath("z2")), bottle({ at: 1546300800000 })));
  await assertSucceeds(setDoc(doc(db, ...evPath("z3")), bottle({ note: "n".repeat(200) })));
  await assertFails(setDoc(doc(db, ...evPath("z4")), bottle({ note: "n".repeat(201) })));
  await assertFails(setDoc(doc(db, ...evPath("z5")), bottle({ type: "diaper" })));
  await assertFails(setDoc(doc(db, ...evPath("z6")), bottle({ hack: true })));
});
test("yazar: üye olmayan adına ✗; eşin adına (geri al) ✓", async () => {
  await assertFails(setDoc(doc(as(A), ...evPath("w1")), bottle({ by: X })));
  await assertSucceeds(setDoc(doc(as(A), ...evPath("w2")), bottle({ by: B })));
});
test("düzenleme: eş, diğerinin kaydını düzeltir ✓; yazarı değiştiremez ✗", async () => {
  await assertSucceeds(updateDoc(doc(as(B), ...evPath("e1")), { ml: 90, updatedAt: new Date() }));
  await assertFails(updateDoc(doc(as(B), ...evPath("e1")), { by: B }));
  await assertFails(updateDoc(doc(as(B), ...evPath("e1")), { ml: 9999 }));
});
test("silme: üye ✓ / izinsiz ✗", async () => {
  await assertFails(deleteDoc(doc(as(X), ...evPath("e1"))));
  await assertSucceeds(deleteDoc(doc(as(B), ...evPath("e1"))));
});
