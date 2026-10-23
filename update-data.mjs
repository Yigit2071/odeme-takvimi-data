#!/usr/bin/env node
/**
 * TCMB EVDS'den uygulamanın ihtiyaç duyduğu verileri çekip remote-data.json'u günceller:
 *   - TÜFE "12 aylık ortalamalara göre değişim" (konut kira artışının yasal üst sınırı)
 *   - USD ve EUR döviz satış kuru (dövizli abonelikleri TL'ye çevirmek için)
 *
 * Kullanım:
 *   node update-data.mjs [hedef.json]          (varsayılan: ./remote-data.json)
 *   node update-data.mjs --check 2026-09=31.49 (TÜFE hesabını açıklanmış bir değerle doğrular, yazmaz)
 *
 * API anahtarı: EVDS_API_KEY ortam değişkeni ya da bu klasördeki .env dosyası.
 * GitHub Actions'ta repo "secret"ı olarak verilir; koda ya da uygulamaya asla girmez.
 *
 * Bağımlılık yok (Node 18+ fetch).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// TÜFE genel endeksi, 2025=100 (veri grubu bie_tukfiy2025). Eski 2003=100 serisi (TP.FG.J0) Ocak 2026'da arşivlendi.
// Doğrulandı: Eylül 2026 → %31,49, Ağustos 2026 → %31,79 (TÜİK'in açıkladığı değerlerle birebir).
// Seri kodu yine değişirse yalnızca burayı güncelle ve --check ile doğrula.
const CPI_SERIES = process.env.EVDS_SERIES || 'TP.TUKFIY2025.GENEL';

// TCMB döviz satış kurları (veri grubu bie_dkdovytl), günlük; hafta sonu/tatil günleri boş gelir.
const FX_SERIES = { USD: 'TP.DK.USD.S.YTL', EUR: 'TP.DK.EUR.S.YTL' };

// Güncel adres evds3; eski evds2 yalnızca yedek olarak denenir.
const ENDPOINTS = [
  (q) => `https://evds3.tcmb.gov.tr/igmevdsms-dis/${q}`,
  (q) => `https://evds2.tcmb.gov.tr/service/evds/${q}`,
];

function loadKey() {
  if (process.env.EVDS_API_KEY) return process.env.EVDS_API_KEY.trim();
  const envFile = join(here, '.env');
  if (existsSync(envFile)) {
    const match = /^EVDS_API_KEY\s*=\s*(.+)$/m.exec(readFileSync(envFile, 'utf8'));
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('EVDS_API_KEY bulunamadı (ortam değişkeni ya da data-pipeline/.env).');
}

const pad = (n) => String(n).padStart(2, '0');
/** EVDS tarih biçimi: GG-AA-YYYY */
const evdsDate = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

/** "2026-9" / "09-2026" / "01-09-2026" gibi EVDS tarihlerini "2026-09"a çevirir. */
function toMonthKey(raw) {
  const s = String(raw).trim();
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${pad(Number(m[2]))}`;
  m = /^(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${pad(Number(m[1]))}`;
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${pad(Number(m[2]))}`;
  return null;
}

/** "23-10-2026" → "2026-10-23" */
function toISODate(raw) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(raw).trim());
  return m ? `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}` : null;
}

/** EVDS seri isteği; adresleri sırayla dener. Boş ya da hatalı yanıtta açıklayıcı hata verir. */
async function evdsSeries(key, series, start, end, extra = '') {
  const query = `series=${series}&startDate=${evdsDate(start)}&endDate=${evdsDate(end)}&type=json${extra}`;
  const errors = [];
  for (const build of ENDPOINTS) {
    const url = build(query);
    const host = new URL(url).host;
    try {
      const res = await fetch(url, { headers: { key, Accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`${host}: HTTP ${res.status} ${text.slice(0, 120)}`);
        continue;
      }
      const items = JSON.parse(text).items ?? [];
      if (items.length === 0) {
        errors.push(`${host}: yanıt geldi ama veri yok (${text.slice(0, 120)})`);
        continue;
      }
      return { items, host };
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
    }
  }
  throw new Error(`EVDS'den ${series} alınamadı:\n  ${errors.join('\n  ')}`);
}

async function fetchCpi(key) {
  const end = new Date();
  const start = new Date(end.getFullYear() - 3, end.getMonth(), 1);
  const { items, host } = await evdsSeries(key, CPI_SERIES, start, end, '&frequency=5');
  const field = CPI_SERIES.replace(/\./g, '_');
  const points = items
    .map((row) => ({ month: toMonthKey(row.Tarih), value: Number(row[field]) }))
    .filter((p) => p.month && Number.isFinite(p.value) && p.value > 0);
  if (points.length === 0) throw new Error(`${CPI_SERIES}: geçerli veri yok`);
  return { points, host };
}

/** En son iş gününün USD ve EUR satış kurları (ikisi de dolu olan son gün). */
async function fetchFx(key) {
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 86_400_000);
  const series = `${FX_SERIES.USD}-${FX_SERIES.EUR}`;
  const { items } = await evdsSeries(key, series, start, end);
  const usdField = FX_SERIES.USD.replace(/\./g, '_');
  const eurField = FX_SERIES.EUR.replace(/\./g, '_');
  const days = items
    .map((row) => ({ date: toISODate(row.Tarih), USD: Number(row[usdField]), EUR: Number(row[eurField]) }))
    .filter((d) => d.date && d.USD > 0 && d.EUR > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = days.at(-1);
  if (!last) throw new Error('Son 14 günde geçerli döviz kuru yok');
  const round4 = (n) => Math.round(n * 10_000) / 10_000;
  return { date: last.date, rates: { USD: round4(last.USD), EUR: round4(last.EUR) } };
}

/**
 * 12 aylık ortalamalara göre % değişim (TÜİK tanımı):
 * son 12 ayın endeks ortalaması / ondan önceki 12 ayın ortalaması − 1.
 */
export function twelveMonthAverageChange(points, period) {
  const byMonth = new Map(points.map((p) => [p.month, p.value]));
  const months = [];
  let [y, m] = period.split('-').map(Number);
  for (let i = 0; i < 24; i++) {
    months.unshift(`${y}-${pad(m)}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const values = months.map((k) => byMonth.get(k));
  if (values.some((v) => v == null)) return null;
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const rate = (avg(values.slice(12)) / avg(values.slice(0, 12)) - 1) * 100;
  return Math.round(rate * 100) / 100;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.find((a) => a.startsWith('--check'));
  const key = loadKey();
  const { points, host } = await fetchCpi(key);
  const latest = points.map((p) => p.month).sort().at(-1);
  console.log(`Kaynak: ${host} · seri ${CPI_SERIES} · ${points.length} ay · son dönem ${latest}`);

  if (check) {
    const [period, expected] = (check.split(' ')[1] ?? args[args.indexOf(check) + 1] ?? '').split('=');
    const rate = twelveMonthAverageChange(points, period);
    const ok = rate != null && Math.abs(rate - Number(expected)) < 0.015;
    console.log(`Doğrulama ${period}: hesaplanan %${rate} · beklenen %${expected} → ${ok ? 'TUTUYOR ✓' : 'TUTMUYOR ✗'}`);
    process.exit(ok ? 0 : 1);
  }

  const rate = twelveMonthAverageChange(points, latest);
  if (rate == null) throw new Error(`${latest} için 24 aylık kesintisiz veri yok; hesap yapılamadı.`);
  const fx = await fetchFx(key);
  console.log(`Kur (${fx.date}): 1 USD = ${fx.rates.USD} TL · 1 EUR = ${fx.rates.EUR} TL`);

  // Uygulamanın kabul ettiği aralıkların aynısı (mobile/src/core/schemas.ts). Dışındaysa YAYINLAMA:
  // iş akışı başarısız olur, GitHub e-posta gönderir, yayındaki son geçerli veri yerinde kalır.
  const problems = [];
  if (!(rate >= -50 && rate <= 200)) problems.push(`TÜFE oranı aralık dışı: ${rate}`);
  for (const [cur, v] of Object.entries(fx.rates)) if (!(v >= 1 && v <= 10_000)) problems.push(`${cur} kuru aralık dışı: ${v}`);
  const parity = fx.rates.EUR / fx.rates.USD;
  if (!(parity > 0.5 && parity < 2)) problems.push(`EUR/USD paritesi tutarsız: ${parity}`);
  if (problems.length) throw new Error(`Veri mantık denetiminden geçmedi, yayınlanmadı:\n  ${problems.join('\n  ')}`);

  const target = resolve(here, args[0] ?? 'remote-data.json');
  const data = JSON.parse(readFileSync(target, 'utf8'));
  const before = JSON.stringify({ t: data.tufe12mAvg, fx: data.fx });
  data.tufe12mAvg = { period: latest, rate };
  data.fx = fx;
  if (JSON.stringify({ t: data.tufe12mAvg, fx: data.fx }) === before) {
    console.log(`Değişiklik yok: TÜFE ${latest} %${rate}, kur ${fx.date}`);
    return;
  }
  data.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
  console.log(`Güncellendi: TÜFE ${latest} %${rate}, kur ${fx.date} (${target})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
