#!/usr/bin/env node
/**
 * TCMB EVDS'den TÜFE endeksini çekip "12 aylık ortalamalara göre değişim"i (kira artış üst sınırı)
 * hesaplar ve uygulamanın okuduğu remote-data.json dosyasını günceller.
 *
 * Kullanım:
 *   node update-tufe.mjs [hedef.json]          (varsayılan: ./remote-data.json)
 *   node update-tufe.mjs --check 2026-09=31.49 (hesabı bilinen bir değerle doğrular, dosyaya yazmaz)
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
const SERIES = process.env.EVDS_SERIES || 'TP.TUKFIY2025.GENEL';

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

async function fetchIndex(key) {
  const end = new Date();
  const start = new Date(end.getFullYear() - 3, end.getMonth(), 1);
  const query = `series=${SERIES}&startDate=${evdsDate(start)}&endDate=${evdsDate(end)}&type=json&frequency=5`;
  const errors = [];

  for (const build of ENDPOINTS) {
    const url = build(query);
    try {
      const res = await fetch(url, { headers: { key, Accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`${new URL(url).host}: HTTP ${res.status} ${text.slice(0, 120)}`);
        continue;
      }
      const json = JSON.parse(text);
      const field = SERIES.replace(/\./g, '_');
      const points = (json.items ?? [])
        .map((row) => ({ month: toMonthKey(row.Tarih), value: Number(row[field]) }))
        .filter((p) => p.month && Number.isFinite(p.value) && p.value > 0);
      if (points.length === 0) {
        errors.push(`${new URL(url).host}: yanıt geldi ama veri yok (${text.slice(0, 120)})`);
        continue;
      }
      return { points, host: new URL(url).host };
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e.message}`);
    }
  }
  throw new Error(`EVDS'den veri alınamadı:\n  ${errors.join('\n  ')}`);
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
  const { points, host } = await fetchIndex(loadKey());
  const latest = points.map((p) => p.month).sort().at(-1);
  console.log(`Kaynak: ${host} · seri ${SERIES} · ${points.length} ay · son dönem ${latest}`);

  if (check) {
    const [period, expected] = (check.split(' ')[1] ?? args[args.indexOf(check) + 1] ?? '').split('=');
    const rate = twelveMonthAverageChange(points, period);
    const ok = rate != null && Math.abs(rate - Number(expected)) < 0.015;
    console.log(`Doğrulama ${period}: hesaplanan %${rate} · beklenen %${expected} → ${ok ? 'TUTUYOR ✓' : 'TUTMUYOR ✗'}`);
    process.exit(ok ? 0 : 1);
  }

  const rate = twelveMonthAverageChange(points, latest);
  if (rate == null) throw new Error(`${latest} için 24 aylık kesintisiz veri yok; hesap yapılamadı.`);

  const target = resolve(here, args[0] ?? 'remote-data.json');
  const data = JSON.parse(readFileSync(target, 'utf8'));
  const changed = data.tufe12mAvg?.period !== latest || data.tufe12mAvg?.rate !== rate;
  if (!changed) {
    console.log(`Değişiklik yok: ${latest} %${rate}`);
    return;
  }
  data.tufe12mAvg = { period: latest, rate };
  data.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
  console.log(`Güncellendi: ${latest} → %${rate} (${target})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
