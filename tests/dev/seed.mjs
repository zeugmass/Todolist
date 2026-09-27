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

console.log("Emülatör test verisi yüklendi: 2 hesap, ortak + 2 kişisel alan, 1 liste.");
