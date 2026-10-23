# Ödeme Takvimi · veri

Ödeme Takvimi uygulamasının internetten okuduğu tek dosya: [`remote-data.json`](remote-data.json)

- **TÜFE 12 aylık ortalamalara göre değişim** (konut kira artışının yasal üst sınırı, TBK 344).
  Kaynak: TCMB EVDS'deki TÜİK TÜFE endeksi; her ayın 3-6'sı arasında GitHub Actions ile otomatik güncellenir.
- **Abonelik servisleri listesi** (fiyatlar henüz eklenmedi).

Dosya GitHub Pages üzerinden yayınlanır; uygulama açılışta buradan çeker ve önbelleğe alır.

## Elle çalıştırma

```sh
cp .env.example .env         # EVDS API anahtarını yaz
node update-tufe.mjs                        # remote-data.json'u günceller
node update-tufe.mjs --check 2026-09=31.49  # hesabı açıklanmış bir değerle doğrular
```

API anahtarı yalnızca `.env` (git'e girmez) ve GitHub'daki `EVDS_API_KEY` secret'ında durur.
