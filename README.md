# Ödeme Takvimi · veri

Ödeme Takvimi uygulamasının internetten okuduğu tek dosya: [`remote-data.json`](remote-data.json)

| Alan | Ne | Kaynak | Güncelleme |
|---|---|---|---|
| `tufe12mAvg` | TÜFE 12 aylık ortalamalara göre değişim (konut kira artışının yasal üst sınırı, TBK 344) | TCMB EVDS `TP.TUKFIY2025.GENEL` (TÜİK, 2025=100) | Her ayın 3-6'sı, otomatik |
| `fx` | USD ve EUR döviz satış kuru (dövizli abonelikleri TL'ye çevirmek için) | TCMB EVDS `TP.DK.USD.S.YTL`, `TP.DK.EUR.S.YTL` | Her iş günü 16:00 (TR), otomatik |
| `services` | Abonelik servisleri ve paket fiyatları | Haber ve resmi duyurulardan elle kontrol (`checkedAt`) | Elle |

Fiyatı doğrulanamayan paketler listeye **eklenmez** (yanlış fiyat, kullanıcıya yanlış "zam" uyarısı verdirir).

Dosya GitHub Pages üzerinden yayınlanır; uygulama açılışta buradan çeker ve önbelleğe alır.

## Elle çalıştırma

```sh
cp .env.example .env         # EVDS API anahtarını yaz
node update-data.mjs                        # remote-data.json'u günceller
node update-data.mjs --check 2026-09=31.49  # TÜFE hesabını açıklanmış bir değerle doğrular
```

API anahtarı yalnızca `.env` (git'e girmez) ve GitHub'daki `EVDS_API_KEY` secret'ında durur.
