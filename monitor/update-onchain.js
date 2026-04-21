/**
 * update-onchain.js — 온체인 지표 자동 수집
 *
 * BGeometrics (bitcoin-data.com) — 무료, API 키 불필요
 *   BATCH=morning (07:20 KST): mvrvZ, nupl, sopr, puell, funding, lthSopr, sthSopr, reserveRisk (8개)
 *   BATCH=evening (18:20 KST): utxo1m, utxo7yr, etfFlow (3개)
 *
 * 제한: 시간당 8회, 하루 15회 (IP 기준, GitHub Actions 공유 IP 주의)
 * 출력: onchain-data.json (루트, GitHub Actions이 commit)
 *
 * 확인된 무료 엔드포인트:
 *   realized-cap-hodl-waves → {age_1w_1m, age_7y_10y, age_10y, ...} (비율, 0~1)
 *   hodl-waves-supply       → 동일 age_* 필드, 단위=절대 BTC
 *   etf-flow-btc            → {etfFlow} 단위=BTC
 *
 * exchange-netflow, nrpl, exchange-reserve → 유료 전용 (404)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'onchain-data.json');
const BASE_URL    = 'https://bitcoin-data.com/v1';

const BATCH = process.env.BATCH || 'morning';
console.log(`🕐 실행 배치: ${BATCH}`);

// ── 아침 배치 (8개) ───────────────────────────────────────────
const MORNING_METRICS = [
  { key:'mvrvZ',       label:'MVRV Z-Score',         urlCandidates:['/v1/mvrv'],          fieldCandidates:['mvrv','value'],                             decimals:2 },
  { key:'nupl',        label:'NUPL',                  urlCandidates:['/v1/nupl'],          fieldCandidates:['nupl','value'],                             decimals:3 },
  { key:'sopr',        label:'SOPR',                  urlCandidates:['/v1/sopr'],          fieldCandidates:['sopr','value'],                             decimals:4 },
  { key:'puell',       label:'Puell Multiple',        urlCandidates:['/v1/puell-multiple'],fieldCandidates:['puellMultiple','puell_multiple','puell','value'], decimals:3 },
  { key:'funding',     label:'Funding Rate (%)',      urlCandidates:['/v1/funding-rate'],  fieldCandidates:['fundingRate','funding_rate','funding','value'], decimals:5 },
  { key:'lthSopr',     label:'LTH SOPR (장기보유자)', urlCandidates:['/v1/lth-sopr'],      fieldCandidates:['lthSopr','lth_sopr','value'],                decimals:4 },
  { key:'sthSopr',     label:'STH SOPR (단기보유자)', urlCandidates:['/v1/sth-sopr'],      fieldCandidates:['sthSopr','sth_sopr','value'],                decimals:4 },
  { key:'reserveRisk', label:'Reserve Risk',          urlCandidates:['/v1/reserve-risk'],  fieldCandidates:['reserveRisk','reserve_risk','value'],         decimals:6 },
];

// ── 저녁 배치 (3개) ────────────────────────────────────────────
// realized-cap-hodl-waves 응답 필드: age_0d_1d, age_1d_1w, age_1w_1m, ... age_7y_10y, age_10y (비율 0~1)
// etf-flow-btc 응답 필드: etfFlow (단위: BTC)
const EVENING_METRICS = [
  {
    key:            'utxo1m',
    label:          'UTXO 1W~1M (%)',
    urlCandidates:  ['/v1/realized-cap-hodl-waves'],
    fieldCandidates:['age_1w_1m'],          // 비율(0~1) → multiplier로 ×100
    multiplier:     100,
    decimals:       1,
  },
  {
    key:            'utxo7yr',
    label:          'UTXO 7yr+ (%)',
    urlCandidates:  ['/v1/realized-cap-hodl-waves'],
    sumFields:      ['age_7y_10y', 'age_10y'], // 7~10yr + 10yr+ 합산 → ×100
    multiplier:     100,
    decimals:       1,
  },
  {
    // 단위: BTC. 임계값 → check-once.js etfFlowZone / HTML metricSt('etfflow') 참조
    // 강유입 >5000 BTC/day | 유입 1500~5000 | 중립 0~1500 | 순유출 <0 | 강유출 <-5000
    key:            'etfFlow',
    label:          'Spot ETF 순유입 (BTC/일)',
    urlCandidates:  ['/v1/etf-flow-btc'],
    fieldCandidates:['etfFlow', 'flow', 'netFlow', 'net_flow', 'value'],
    decimals:       1,
  },
];

const METRICS = BATCH === 'evening' ? EVENING_METRICS : MORNING_METRICS;

// ── 응답에서 최신 값 추출 ─────────────────────────────────────
// opts.sumFields: 지정 필드 합산 후 반환 (fieldCandidates 무시)
// returns { value, date } or null
function extractLatest(data, fieldCandidates, sumFields) {
  if (data && !Array.isArray(data) && typeof data === 'object' && !data.error) {
    data = [data];
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  const DATE_KEYS = new Set(['t', 'date', 'day', 'timestamp', 'time', 'd', 'unixTs', 'id']);

  const sorted = [...data].sort((a, b) => {
    const da = [...DATE_KEYS].map(k => a[k]).find(v => v != null) ?? '';
    const db = [...DATE_KEYS].map(k => b[k]).find(v => v != null) ?? '';
    return String(db).localeCompare(String(da));
  });

  console.log(`   최신 레코드:`, JSON.stringify(sorted[0]));

  // 레코드 날짜 추출 헬퍼
  const getDate = (record) => {
    for (const k of DATE_KEYS) {
      if (record[k] != null) return String(record[k]);
    }
    return null;
  };

  for (const record of sorted) {
    const recordDate = getDate(record);

    // sumFields 모드: 지정 필드 합산 (utxo7yr 등)
    if (sumFields && sumFields.length > 0) {
      let sum = 0, found = 0;
      for (const f of sumFields) {
        const raw = record[f];
        if (raw != null) {
          const n = parseFloat(raw);
          if (!isNaN(n)) { sum += n; found++; }
        }
      }
      if (found > 0) return { value: sum, date: recordDate };
      continue;
    }

    // fieldCandidates 탐색
    for (const f of fieldCandidates) {
      const raw = record[f];
      if (raw != null) {
        const n = parseFloat(raw);
        if (!isNaN(n)) return { value: n, date: recordDate };
      }
    }
    // 후보 실패 시 첫 번째 숫자형 필드 자동 탐색
    for (const [k, v] of Object.entries(record)) {
      if (!DATE_KEYS.has(k)) {
        const n = parseFloat(v);
        if (!isNaN(n) && isFinite(n)) return { value: n, date: recordDate };
      }
    }
  }
  return null;
}

// ── 단일 지표 수집 ────────────────────────────────────────────
async function fetchMetric(metric) {
  const params = `?size=5`;

  for (const ep of metric.urlCandidates) {
    const url = `https://bitcoin-data.com${ep}${params}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        console.error(`   ⚠️ 429 Rate Limit 초과 — ${url}`);
        return null;
      }
      if (res.status === 404) {
        console.log(`   404 → 다음 후보 시도`);
        continue;
      }
      if (!res.ok) {
        console.error(`   HTTP ${res.status} — ${url}`);
        continue;
      }
      const data = await res.json();
      if (data?.error) {
        console.error(`   API 오류: ${JSON.stringify(data.error)}`);
        continue;
      }
      const extracted = extractLatest(data, metric.fieldCandidates, metric.sumFields);
      if (extracted == null) {
        console.log(`   데이터 없음 (빈 배열 또는 필드 불일치) — ${ep}`);
        continue;
      }
      const value = parseFloat((extracted.value * (metric.multiplier || 1)).toFixed(metric.decimals));
      console.log(`   ✅ ${ep} → ${value} (날짜: ${extracted.date})`);
      return { value, date: extracted.date, endpoint: ep };
    } catch (e) {
      console.error(`   오류: ${e.message} — ${url}`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

function loadPrev() {
  try { return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')); }
  catch { return {}; }
}

async function main() {
  console.log('🚀 BGeometrics 온체인 지표 수집 시작');
  console.log(`   API: ${BASE_URL} | 하루 최대 15회 | BATCH=${BATCH}\n`);

  const prev   = loadPrev();
  const result = { ...prev };
  const log    = [];

  for (const metric of METRICS) {
    console.log(`\n📊 ${metric.label}`);
    const res = await fetchMetric(metric);
    if (res) {
      result[metric.key] = res.value;
      if (metric.key === 'etfFlow' && res.date) result.etfFlowDate = res.date;
      log.push(`  ✅ ${metric.label}: ${res.value}  (${res.endpoint})`);
    } else {
      log.push(`  ⚠️  ${metric.label}: 수집 실패 → 이전값 ${prev[metric.key] ?? '없음'} 유지`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  result.updatedAt    = new Date().toISOString();
  result.updatedAtKST = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  result.source       = 'bitcoin-data.com (BGeometrics)';

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));

  console.log('\n─────────────────────────────────');
  log.forEach(l => console.log(l));
  console.log(`\n✅ 완료 — ${result.updatedAtKST}`);
  console.log(`💾 저장: onchain-data.json`);
  process.exit(0);
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
