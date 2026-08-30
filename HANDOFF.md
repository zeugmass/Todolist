# Görevler — Proje Devir / Durum Notu

> Bu dosya, sohbeti **başka bir bilgisayarda** sürdürebilmek için proje durumunu özetler.
> Claude bu dosyayı okuyup kaldığı yerden devam edebilir.

## 1. Proje nedir?
**Görevler** — kullanıcı (Ersin) ve eşinin ortak kullandığı, iPhone'da ana ekrana eklenen **PWA** yapılacaklar uygulaması. Firebase (Auth + Firestore + FCM) + saf HTML/CSS/JS. GitHub Pages'te barınır.

- **Canlı site:** https://zeugmass.github.io/Todolist/
- **Repo:** https://github.com/zeugmass/Todolist
- **Firebase projesi:** `todo-72119` (Blaze planı aktif — Cloud Functions için)
- **Sahip Google hesabı:** ersinakyz07@gmail.com

## 2. Mimari
- **Frontend:** `index.html`, `app.js` (tüm mantık, tek dosya, ES modülleri, Firebase 10.12.2 CDN), `styles.css` (minimal siyah-beyaz, sistem teması).
- **Auth:** Firebase e-posta/şifre.
- **Veri:** Firestore (long-polling + persistentSingleTabManager — iOS PWA güvenilirliği için).
- **Bildirim:** FCM web push + `firebase-messaging-sw.js`; zamanlanmış Cloud Function.
- **PWA:** `manifest.webmanifest`, `sw.js` (network-first, otomatik güncelleme).

## 3. Veri modeli (Firestore)
- `users/{uid}` = `{ spaceId (aktif alan), email, spaces: { <spaceId>: {shared:bool} }, fcmTokens: [] }`
  - Alan üyelik işaretçileri **harita alanı** olarak burada tutulur (alt-koleksiyon DEĞİL — kural sadeliği için).
- `spaces/{spaceId}` = `{ ownerUid, inviteCode, shared:bool, createdAt }`
  - `shared:false` = **Kişisel** (tek kişi), `shared:true` = **Ortak** (eşle paylaşılan).
- `spaces/{spaceId}/members/{uid}` = `{ email, joinedAt }`
- `spaces/{spaceId}/lists/{listId}` = `{ title, emoji, createdAt, createdBy }`
- `spaces/{spaceId}/lists/{listId}/todos/{todoId}` = `{ text, note, done, order, createdAt, createdBy, createdByEmail, doneBy, doneByEmail, doneAt, dueAt(ms), repeat, weekdays[], notifiedFor }`
- `spaces/{spaceId}/frequent/{key}` = `{ text, count, lastUsed }` (otomatik tamamlama)
- `invites/{code}` = `{ spaceId }` (kod → alan eşlemesi; katılma için)

Güvenlik kuralları: `firestore.rules`. **Kritik:** `invites` yalnızca `get` (list KAPALI — enumeration açığı buradan kapatıldı).

## 4. Yapılan özellikler
- Ekle/düzenle/sil (geri al'lı), yuvarlak checkbox → üstü çizili, sürükle-sırala (SortableJS).
- Çoklu liste + emoji; **Kişisel / Ortak alan** ayrımı ve üstteki geçiş şeridi.
- Davet kodu ile eşi Ortak alana bağlama; "Bağlantıyı kes".
- Miktar/not, "kim ekledi/tamamladı" rozeti (yalnız Ortak'ta), tamamlananlar bölümü + sayaç.
- Sık eklenenler otomatik tamamlama.
- **Son tarih + tekrar** (Her gün / Haftalık→gün seç / Her ay); tekrarlayanı işaretleme sadece "yapıldı" yapar, **tarih ilerletme SUNUCUDA**.
- **Gerçek push bildirim** (FCM + Cloud Function `sendReminders`, dakikada bir).
- İlaç takibi: Kişisel alanda "Her gün + saat" tekrarlı görevler.
- Fazla boş Kişisel alanı otomatik temizleme (`healDuplicatePersonals`).
- `?debug=1` ile ekran-üstü zamanlama günlüğü.

## 5. DEPLOY SÜRECİ (çok önemli — iki ayrı kanal)
| Değişen | Nereye | Komut/Yöntem |
|---|---|---|
| **Web** (`index.html`, `app.js`, `styles.css`, `sw.js`, `firebase-messaging-sw.js`, ikonlar, manifest) | GitHub Pages | GitHub'a **push** (GitHub Desktop) |
| **Kurallar** (`firestore.rules`) | Firebase | `firebase deploy --only firestore:rules` |
| **Fonksiyon** (`functions/index.js`) | Firebase | `firebase deploy --only functions` |
| **Index** (`firestore.indexes.json`) | Firebase | `firebase deploy --only firestore:indexes` |

- Web push'landıktan sonra iPhone'da: uygulamayı **tamamen kapatıp aç**; takılırsa **ana ekrandan silip yeniden ekle** (SW önbelleği). `sw.js` otomatik güncelleme de var.
- `firebase-config.js` içindeki `apiKey`/VAPID **gizli değildir** (herkese açık olması normal).

## 6. Güvenlik durumu
- **Firebase-native pentest yapıldı** (canlı, tek-kullanımlık saldırgan hesaplarla). Bulunan **kritik açık düzeltildi ve doğrulandı:** `invites` koleksiyonu listelenebiliyordu → herkes tüm spaceId'leri çekip her alana girebiliyordu. Kural `allow read` → `allow get` yapıldı; artık enumeration engelli.
- Güvenli doğrulananlar: users belgesi izolasyonu, alan oluşturma (ownerUid sahtelenemez), collectionGroup/spaces list engelli, istemci XSS (`textContent` + `escapeHtml/escapeAttr`), Cloud Function (Admin SDK, dışarıdan tetiklenemez).
- **Kalan (düşük risk, opsiyonel sertleştirme):** bir spaceId API-dışı sızarsa katılma hâlâ mümkün. İstenirse katılmayı "geçerli davet kodu şart" yaparız (alan oluşturmayı 2 adıma bölen değişiklik + kural). Kullanıcı şimdilik "bu haliyle yeterli" dedi.

## 7. Bilinen davranışlar / gotchas
- **Türkiye UTC+3 sabit** (yaz saati yok) — sunucu tarih hesabı bunu kullanıyor (`functions/index.js` OFFSET).
- Tekrarlayan görevlerin gün-dönüşü **sunucuda** (`reArmRecurring` istemciden kaldırıldı — çift-cihaz yazma döngüsü/kilitlenmeye yol açıyordu).
- Migration: eski tek-alanlı hesaplar ilk açılışta Kişisel+Ortak'a taşınır (`backfillPointers`, `data.spaceId` kullanır).
- Testler canlı projede tek-kullanımlık `zz_...@example.com` hesaplarıyla yapılıp temizlenir (emülatör yok çünkü Java kurulu değildi).

## 8. Bekleyen / olası sonraki işler
- (Opsiyonel) Kalan güvenlik sertleştirmesi: katılmada davet-kodu zorunluluğu.
- (Fikir) Güvenlik test setleri: Semgrep + gitleaks + CodeQL (CI), ZAP/Burp, Nuclei, PentestGPT/Strix — kullanıcıyla konuşuldu, ileride kurulabilir.
- Kullanıcının aklındaki diğer özellikler geldikçe.

## 9. Yeni makinede (masaüstü) nasıl devam edilir
1. Repoyu klonla/çek (GitHub Desktop): https://github.com/zeugmass/Todolist
2. Backend deploy gerekirse: **Node.js + `npm i -g firebase-tools`** kur, `firebase login` (ersinakyz07 hesabıyla). `.firebaserc` zaten `todo-72119`'a bağlı.
3. Yerel test: klasörde `python -m http.server 8000` → tarayıcıda aç (Firebase canlı `todo-72119`'a bağlanır). PWA push testi ancak gerçek iPhone'da (ana ekran uygulaması) çalışır.
4. Bu dosyayı (`HANDOFF.md`) Claude'a okut → kaldığı yerden devam.

## 10. Kullanıcı bağlamı
- Türkçe konuşur, teknik olmayan bir kullanıcı — adım adım, net yönlendirme ister.
- GitHub **Desktop** kullanıyor (komut satırı değil); `firebase` CLI'ı bu proje için kurdu.
- İletişim sıcak, sabırlı, "önce fikir alışverişi sonra kod" tarzını sever.
