// firestore.rules saldırı/izin testleri — YALNIZ emülatörde (demo-todo) çalışır.
// Çalıştırma: tests/rules klasöründe `npm test`
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, collection, writeBatch, Timestamp
} from "firebase/firestore";

const A = "oBakqJgdSzbm6HL1JBWcGTsI1kJ2"; // izinli (alan sahibi)
const B = "7GBK0HeVh3cJyVrWanXUfnQHJTy2"; // izinli (eş)
const X = "attacker-uid-zz";              // izinsiz saldırgan

const SHARED = "sharedSpace1", PERSONAL = "personalSpaceA", OTHER = "otherShared";
const H = 3600000;
const inHours = (h) => Timestamp.fromMillis(Date.now() + h * H);

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-todo",
    firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8") }
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  // Tohum: A'nın ortak alanı (üye: A), A'nın kişisel alanı, başka bir ortak alan (üye: B)
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "spaces", SHARED), { ownerUid: A, shared: true });
    await setDoc(doc(db, "spaces", SHARED, "members", A), { email: "a@x" });
    await setDoc(doc(db, "spaces", SHARED, "lists", "L1"), { title: "Liste" });
    await setDoc(doc(db, "spaces", SHARED, "lists", "L1", "todos", "T1"), { text: "süt al" });
    await setDoc(doc(db, "spaces", PERSONAL), { ownerUid: A, shared: false });
    await setDoc(doc(db, "spaces", PERSONAL, "members", A), { email: "a@x" });
    await setDoc(doc(db, "spaces", OTHER), { ownerUid: B, shared: true });
    await setDoc(doc(db, "spaces", OTHER, "members", B), { email: "b@x" });
    await setDoc(doc(db, "invites", "OTHERCD2"), { spaceId: OTHER, createdBy: B, expiresAt: inHours(20) });
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
const seedInvite = (code, data) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "invites", code), data));
const joinBatch = (db, sid, code, uid) => {
  const b = writeBatch(db);
  b.set(doc(db, "spaces", sid, "members", uid), { email: "b@x", inviteCode: code });
  b.set(doc(db, "users", uid), { spaceId: sid, spaces: { [sid]: { shared: true } } }, { merge: true });
  b.delete(doc(db, "invites", code));
  return b.commit();
};

// ── 1) İZİN LİSTESİ: izinsiz hesap HİÇBİR ŞEYE erişemez ─────────────────────
test("izinsiz: kendi users belgesini bile okuyamaz/yazamaz", async () => {
  await assertFails(setDoc(doc(as(X), "users", X), { email: "x@x" }));
  await assertFails(getDoc(doc(as(X), "users", X)));
});
test("izinsiz: doğru davet kodunu bilse bile okuyamaz", async () => {
  await assertFails(getDoc(doc(as(X), "invites", "OTHERCD2")));
});
test("izinsiz: alan oluşturamaz", async () => {
  await assertFails(setDoc(doc(as(X), "spaces", "xs"), { ownerUid: X, shared: true }));
});
test("izinsiz: bir şekilde üye kaydı olsa bile listeleri/görevleri OKUYAMAZ (son kilit)", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "spaces", SHARED, "members", X), { email: "x@x" }));
  await assertFails(getDoc(doc(as(X), "spaces", SHARED, "lists", "L1", "todos", "T1")));
  await assertFails(getDocs(collection(as(X), "spaces", SHARED, "lists")));
});
test("anonim (girişsiz): hiçbir şey okuyamaz", async () => {
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, "spaces", SHARED)));
  await assertFails(getDoc(doc(anon, "invites", "OTHERCD2")));
});

// ── 2) DAVET KODLARI ─────────────────────────────────────────────────────────
test("davetler LİSTELENEMEZ (izinli kullanıcı dahil)", async () => {
  await assertFails(getDocs(collection(as(A), "invites")));
});
test("sahip: ortak alanı için geçerli kod oluşturabilir (8 karakter, 24 saat)", async () => {
  const db = as(A); const b = writeBatch(db);
  b.set(doc(db, "invites", "ABCD2345"), { spaceId: SHARED, createdBy: A, createdAt: Timestamp.now(), expiresAt: inHours(24) });
  b.update(doc(db, "spaces", SHARED), { inviteCode: "ABCD2345" });
  await assertSucceeds(b.commit());
});
test("kod: 6 karakter / küçük harf / yasak harf → RED", async () => {
  const db = as(A);
  await assertFails(setDoc(doc(db, "invites", "ABCD23"), { spaceId: SHARED, createdBy: A, expiresAt: inHours(24) }));
  await assertFails(setDoc(doc(db, "invites", "abcd2345"), { spaceId: SHARED, createdBy: A, expiresAt: inHours(24) }));
  await assertFails(setDoc(doc(db, "invites", "ABCD2340"), { spaceId: SHARED, createdBy: A, expiresAt: inHours(24) })); // 0 yasak
});
test("kod: 48 saat geçerlilik / zaten geçmiş / tarih yok → RED", async () => {
  const db = as(A);
  await assertFails(setDoc(doc(db, "invites", "ABCD2345"), { spaceId: SHARED, createdBy: A, expiresAt: inHours(48) }));
  await assertFails(setDoc(doc(db, "invites", "ABCD2345"), { spaceId: SHARED, createdBy: A, expiresAt: inHours(-1) }));
  await assertFails(setDoc(doc(db, "invites", "ABCD2345"), { spaceId: SHARED, createdBy: A }));
});
test("kod: KİŞİSEL alan için oluşturulamaz", async () => {
  await assertFails(setDoc(doc(as(A), "invites", "ABCD2345"), { spaceId: PERSONAL, createdBy: A, expiresAt: inHours(24) }));
});
test("kod: başkası adına (createdBy sahte) / fazladan alan → RED", async () => {
  const db = as(A);
  await assertFails(setDoc(doc(db, "invites", "ABCD2345"), { spaceId: SHARED, createdBy: B, expiresAt: inHours(24) }));
  await assertFails(setDoc(doc(db, "invites", "ABCD2345"), { spaceId: SHARED, createdBy: A, expiresAt: inHours(24), hack: 1 }));
});
test("üye olmayan (izinli olsa bile) başkasının alanına kod oluşturamaz", async () => {
  await assertFails(setDoc(doc(as(B), "invites", "ABCD2345"), { spaceId: SHARED, createdBy: B, expiresAt: inHours(24) }));
});
test("üye olmayan, başkasının davetini silemez", async () => {
  await seedInvite("ABCD2345", { spaceId: SHARED, createdBy: A, expiresAt: inHours(24) });
  await assertFails(deleteDoc(doc(as(B), "invites", "ABCD2345")));
});
test("davet güncellenemez", async () => {
  await seedInvite("ABCD2345", { spaceId: SHARED, createdBy: A, expiresAt: inHours(24) });
  await assertFails(updateDoc(doc(as(A), "invites", "ABCD2345"), { expiresAt: inHours(24) }));
});

// ── 3) KATILMA ───────────────────────────────────────────────────────────────
test("alan kimliğini bilmek KATILMAYA YETMEZ (kodsuz katılma → RED)", async () => {
  await assertFails(setDoc(doc(as(B), "spaces", SHARED, "members", B), { email: "b@x" }));
});
test("başka alanın koduyla katılma → RED", async () => {
  await assertFails(joinBatch(as(B), SHARED, "OTHERCD2", B));
});
test("süresi dolmuş kodla katılma → RED", async () => {
  await seedInvite("ABCD2345", { spaceId: SHARED, createdBy: A, expiresAt: inHours(-1) });
  await assertFails(joinBatch(as(B), SHARED, "ABCD2345", B));
});
test("olmayan kodla katılma → RED", async () => {
  await assertFails(joinBatch(as(B), SHARED, "ZZZZ2345", B));
});
test("başkasını (B'yi) üye yapmaya çalışma → RED", async () => {
  await seedInvite("ABCD2345", { spaceId: SHARED, createdBy: A, expiresAt: inHours(24) });
  await assertFails(setDoc(doc(as(A), "spaces", SHARED, "members", B), { email: "b@x", inviteCode: "ABCD2345" }));
});
test("GEÇERLİ kodla katılma ÇALIŞIR, kod tek kullanımlıktır", async () => {
  await seedInvite("ABCD2345", { spaceId: SHARED, createdBy: A, expiresAt: inHours(24) });
  const db = as(B);
  await assertSucceeds(joinBatch(db, SHARED, "ABCD2345", B));
  await assertSucceeds(getDoc(doc(db, "spaces", SHARED, "lists", "L1", "todos", "T1"))); // artık okuyabilir
  let stillThere = true; // withSecurityRulesDisabled değer döndürmez → içeride yakala
  await env.withSecurityRulesDisabled(async (ctx) => {
    stillThere = (await getDoc(doc(ctx.firestore(), "invites", "ABCD2345"))).exists();
  });
  if (stillThere) throw new Error("kod katılımdan sonra silinmeliydi");
  // ayrılıp aynı kodla tekrar girmeye çalışma → RED
  await assertSucceeds(deleteDoc(doc(db, "spaces", SHARED, "members", B)));
  await assertFails(joinBatch(db, SHARED, "ABCD2345", B));
});

// ── 4) ALAN BÜTÜNLÜĞÜ ────────────────────────────────────────────────────────
test("üye olmayan izinli kullanıcı başkasının listelerini/görevlerini okuyamaz", async () => {
  await assertFails(getDoc(doc(as(B), "spaces", SHARED, "lists", "L1", "todos", "T1")));
  await assertFails(getDoc(doc(as(B), "spaces", SHARED)));
});
test("üye: görev okur/yazar", async () => {
  const db = as(A);
  await assertSucceeds(getDoc(doc(db, "spaces", SHARED, "lists", "L1", "todos", "T1")));
  await assertSucceeds(setDoc(doc(db, "spaces", SHARED, "lists", "L1", "todos", "T2"), { text: "bez" }));
});
test("sahiplik (ownerUid) değiştirilemez; 'shared' işareti güncellenebilir", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "spaces", SHARED, "members", B), { email: "b@x" }));
  await assertFails(updateDoc(doc(as(B), "spaces", SHARED), { ownerUid: B }));
  await assertSucceeds(setDoc(doc(as(A), "spaces", SHARED), { shared: true }, { merge: true }));
});

// ── 5) UYGULAMANIN GERÇEK AKIŞLARI HÂLÂ ÇALIŞIYOR MU? ───────────────────────
test("akış: yeni ortak alan oluşturma (alan + sahip üyeliği + users) tek batch", async () => {
  const db = as(A); const b = writeBatch(db);
  b.set(doc(db, "spaces", "newShared"), { ownerUid: A, shared: true, createdAt: Timestamp.now() });
  b.set(doc(db, "spaces", "newShared", "members", A), { email: "a@x", joinedAt: Timestamp.now() });
  b.set(doc(db, "users", A), { spaceId: "newShared", spaces: { newShared: { shared: true } } }, { merge: true });
  await assertSucceeds(b.commit());
});
test("akış: yeni kişisel alan oluşturma (davet kodu YOK)", async () => {
  const db = as(A); const b = writeBatch(db);
  b.set(doc(db, "spaces", "newPersonal"), { ownerUid: A, shared: false, createdAt: Timestamp.now() });
  b.set(doc(db, "spaces", "newPersonal", "members", A), { email: "a@x", joinedAt: Timestamp.now() });
  b.set(doc(db, "users", A), { spaces: { newPersonal: { shared: false } } }, { merge: true });
  await assertSucceeds(b.commit());
});
test("akış: kodu yenileme (eski kodu sil + yenisini yaz + alanı güncelle)", async () => {
  await seedInvite("OLDC2345", { spaceId: SHARED, createdBy: A, expiresAt: inHours(3) });
  const db = as(A); const b = writeBatch(db);
  b.delete(doc(db, "invites", "OLDC2345"));
  b.set(doc(db, "invites", "NEWC2345"), { spaceId: SHARED, createdBy: A, createdAt: Timestamp.now(), expiresAt: inHours(24) });
  b.update(doc(db, "spaces", SHARED), { inviteCode: "NEWC2345" });
  await assertSucceeds(b.commit());
});
test("akış: bağlantıyı kes (üyelikten çık + kişisel alan oluştur + users güncelle)", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "spaces", SHARED, "members", B), { email: "b@x" });
    await setDoc(doc(ctx.firestore(), "users", B), { spaceId: SHARED, spaces: { [SHARED]: { shared: true } } });
  });
  const db = as(B); const b = writeBatch(db);
  b.delete(doc(db, "spaces", SHARED, "members", B));
  b.set(doc(db, "spaces", "bPersonal"), { ownerUid: B, shared: false, createdAt: Timestamp.now() });
  b.set(doc(db, "spaces", "bPersonal", "members", B), { email: "b@x", joinedAt: Timestamp.now() });
  b.update(doc(db, "users", B), { spaceId: "bPersonal", [`spaces.${SHARED}`]: null, "spaces.bPersonal": { shared: false } });
  await assertSucceeds(b.commit());
});
test("akış: fazla boş kişisel alanı temizleme (üyelik + eski kod + alan) tek batch", async () => {
  await seedInvite("LEGACY23", { spaceId: PERSONAL }); // eski biçim kod (süresiz)
  const db = as(A); const b = writeBatch(db);
  b.delete(doc(db, "spaces", PERSONAL, "members", A));
  b.delete(doc(db, "invites", "LEGACY23"));
  b.delete(doc(db, "spaces", PERSONAL));
  await assertSucceeds(b.commit());
});
test("akış: eski kullanıcı taşıma (backfill: shared işaretini yaz)", async () => {
  await assertSucceeds(setDoc(doc(as(A), "spaces", PERSONAL), { shared: false }, { merge: true }));
});
