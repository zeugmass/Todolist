# Görevler — Paylaşımlı Yapılacaklar (PWA)

İki kişinin ortak kullandığı, gerçek zamanlı senkronlanan yapılacaklar listesi.
Firebase (Auth + Firestore) + saf HTML/CSS/JS. GitHub Pages'te barınır, iPhone'da ana ekrana eklenir.

## Özellikler
- E-posta/şifre ile giriş, iki ayrı hesap
- Çoklu liste (Alışveriş, Ev işleri, ...), her biri başlıklı
- Davet kodu ile eşini listeye ekleme → anlık senkron
- Yuvarlak checkbox → üstü çizili tamamlama
- Satır içi düzenleme, geri al'lı silme, tamamlananları temizle
- Sürükle-sırala (telefonda basılı tutup sürükle)
- Çevrimdışı çalışır, bağlanınca senkronlar
- Otomatik açık/koyu tema (minimal siyah-beyaz)

## Kurulum adımları

### 1) Firestore güvenlik kurallarını yayınla
Firebase Console → **Firestore Database → Rules** sekmesi →
`firestore.rules` dosyasının içeriğini komple yapıştır → **Publish**.

### 2) GitHub Pages'e yükle (kod bilgisi gerekmez)
1. github.com → yeni repo (ör. `gorevler`), **Public**.
2. **Add file → Upload files** → bu klasördeki TÜM dosyaları sürükle → Commit.
3. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main** / **/(root)** → Save.
4. 1-2 dk sonra `https://KULLANICIADIN.github.io/gorevler/` adresi hazır.

### 3) iPhone'da ana ekrana ekle
Safari ile adresi aç → **Paylaş** → **Ana Ekrana Ekle**.

### 4) Eşinle bağlan
- Sen: Üye ol → Yeni liste oluştur → sağ üst menü → **Davet kodunu göster** → kodu eşine yolla.
- Eşin: Kendi hesabıyla üye ol → sol menü → **Listeye katıl** → kodu gir. Tamam!

## Not
`firebase-config.js` içindeki `apiKey` gizli değildir; güvenlik Firestore kurallarıyla sağlanır.
Uygulamayı güncelleyince `sw.js` içindeki `CACHE = "gorevler-v1"` sürümünü artır (v2, v3...).
