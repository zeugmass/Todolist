// YEREL GELİŞTİRME: Firebase EMÜLATÖRÜNE (127.0.0.1) test verisi yükler. Canlıya ASLA dokunmaz.
// Kullanım: emülatörler açıkken  node tests/dev/seed.mjs
// Hesaplar yalnız emülatörde vardır; şifreler de yalnız bu sahte ortam içindir.
// uid'ler firestore.rules izin listesindekilerle AYNI olmalı (yoksa kurallar her şeyi reddeder).
const PROJECT = "todo-72119";
const AUTH = `http://127.0.0.1:9099`;
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };

export const DEV_ACCOUNTS = [
  { uid: "oBakqJgdSzbm6HL1JBWcGTsI1kJ2", email: "ebeveyn1@test.local", password: "emu-test-ebeveyn-1" },
  { uid: "7GBK0HeVh3cJyVrWanXUfnQHJTy2", email: "ebeveyn2@test.local", password: "emu-test-ebeveyn-2" }
];
const [A, B] = DEV_ACCOUNTS;

function val(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) } };
}
async function put(path, data) {
  const r = await fetch(`${FS}/${path}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields: val(data).mapValue.fields }) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
}

// Temizle
await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });

// Hesaplar (belirli uid ile)
for (const a of DEV_ACCOUNTS) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
    method: "POST", headers: OWNER, body: JSON.stringify({ localId: a.uid, email: a.email, password: a.password })
  });
  if (!r.ok) throw new Error(`hesap ${a.email}: ${r.status} ${await r.text()}`);
}

// Alanlar: ortak (ikisi) + her birine kişisel
const now = new Date();
await put("spaces/devShared", { ownerUid: A.uid, shared: true, createdAt: now });
await put(`spaces/devShared/members/${A.uid}`, { email: A.email, joinedAt: now });
await put(`spaces/devShared/members/${B.uid}`, { email: B.email, joinedAt: now });
await put("spaces/devPersonalA", { ownerUid: A.uid, shared: false, createdAt: now });
await put(`spaces/devPersonalA/members/${A.uid}`, { email: A.email, joinedAt: now });
await put("spaces/devPersonalB", { ownerUid: B.uid, shared: false, createdAt: now });
await put(`spaces/devPersonalB/members/${B.uid}`, { email: B.email, joinedAt: now });
await put(`users/${A.uid}`, { email: A.email, spaceId: "devShared", spaces: { devShared: { shared: true }, devPersonalA: { shared: false } } });
await put(`users/${B.uid}`, { email: B.email, spaceId: "devShared", spaces: { devShared: { shared: true }, devPersonalB: { shared: false } } });
await put("spaces/devShared/lists/L1", { title: "Alışveriş", emoji: "🛒", createdAt: now, createdBy: A.uid });
await put("spaces/devShared/lists/L1/todos/T1", { text: "Süt al", note: "", done: false, order: 1, createdAt: now, createdBy: A.uid, createdByEmail: A.email });

// Hazır test bebeği + 1 saat önce biberon (Faz 2 testlerini hızlandırmak için)
const at = Date.now() - 3600000;
await put("spaces/devShared/babies/devBaby", { name: "Test Bebek", birthDate: "2026-09-10", feedReminderHours: 3, createdBy: A.uid, createdAt: now, tz: "Europe/Paris", lastFeedAt: at, nextFeedAt: at + 3 * 3600000 });
await put("spaces/devShared/babies/devBaby/events/f1", { type: "feed", method: "bottle", at, ml: 120, milk: "breast", note: null, by: A.uid, tz: "Europe/Paris", createdAt: now, updatedAt: now });

// Grafik testleri için: 3 gelişim ölçümü + son 6 günün biberon/bez/uyku kayıtları (uydurma)
const base = { by: A.uid, tz: "Europe/Paris", note: null, createdAt: now, updatedAt: now };
const noon = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
await put("spaces/devShared/babies/devBaby/events/g1", { ...base, type: "growth", at: noon(2026, 9, 10), weightG: 3400, lengthMm: 500, headMm: 345 });
await put("spaces/devShared/babies/devBaby/events/g2", { ...base, type: "growth", at: noon(2026, 9, 17), weightG: 3480, lengthMm: null, headMm: null });
await put("spaces/devShared/babies/devBaby/events/g3", { ...base, type: "growth", at: noon(2026, 9, 24), weightG: 3750, lengthMm: 520, headMm: 355 });
const dayMs = 86400000, today0 = new Date(); today0.setHours(0, 0, 0, 0);
let n = 0;
for (let d = 6; d >= 1; d--) {
  const s = today0.getTime() - d * dayMs;
  for (let k = 0; k < 5 + (d % 3); k++) await put(`spaces/devShared/babies/devBaby/events/b${n++}`, { ...base, type: "feed", method: "bottle", at: s + (1 + k * 4) * 3600000, ml: 80 + ((d * 7 + k * 13) % 5) * 10, milk: "formula" });
  for (let k = 0; k < 5 + (d % 2) * 2; k++) await put(`spaces/devShared/babies/devBaby/events/d${n++}`, { ...base, type: "diaper", at: s + (2 + k * 3) * 3600000, pee: true, poo: k % 3 === 0 });
  for (let k = 0; k < 3; k++) await put(`spaces/devShared/babies/devBaby/events/s${n++}`, { ...base, type: "sleep", at: s + (3 + k * 6) * 3600000, endAt: s + (3 + k * 6) * 3600000 + (2 + (d + k) % 3) * 3600000 });
}

console.log("Emülatör test verisi yüklendi: 2 hesap, ortak + 2 kişisel alan, 1 liste, 1 test bebeği (+ ölçümler, 6 günlük geçmiş).");
