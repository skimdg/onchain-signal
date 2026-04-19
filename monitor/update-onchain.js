/**
 * update-onchain.js — 온체인 지표 자동 수집
 *
 * BGeometrics (bitcoin-data.com) — 무료, API 키 불필요
 *   BATCH=morning (07:20 KST): mvrvZ, nupl, sopr, puell, funding, lthSopr, sthSopr, reserveRisk (8개)
 *   BATCH=evening (18:20 KST): netflow, nrpl, exchReserve, utxo1m, utxo7yr (5개)
 *
 * 제한: 시간당 8회, 하루 15회 (IP 기준)
 * 출력: onchain-data.json (루트, GitHub Actions이 commit)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'onchain-data.json');
const BASE_URL    = 'https://bitcoin-data.com/v1';

// BATCH=morning(기본): 8개 수집 | BATCH=evening: 5개 추가 수집
const BATCH = process.env.BATCH || 'morning';
console.log(`🕐 실행 배치: ${BATCH}`);

// ── 아침 배치 (8개) ───────────────────────────────────────────
const MORNING_METRICS = [
  {
    key:            'mvrvZ',
    label:          'MVRV Z-Score',
    urlCandidates:  ['/v1/mvrv'],
    fieldCandidates:['mvrv', 'value'],
    decimals:       2,
  },
  {
    key:            'nupl',
    label:          'NUPL',
    urlCandidates:  ['/v1/nupl'],
    fieldCandidates:['nupl', 'value'],
    decimals:       3,
  },
  {
    key:            'sopr',
    label:          'SOPR',
    urlCandidates:  ['/v1/sopr'],
    fieldCandidates:['sopr', 'value'],
    decimals:       4,
  },
  {
    key:            'puell',
    label:          'Puell Multiple',
    urlCandidates:  ['/v1/puell-multiple'],
    fieldCandidates:['puellMultiple', 'puell_multiple', 'puell', 'value'],
    decimals:       3,
  },
  {
    key:            'funding',
    label:          'Funding Rate (%)',
    urlCandidates:  ['/v1/funding-rate'],
    fieldCandidates:['fundingRate', 'funding_rate', 'funding', 'value'],
    decimals:       5,
  },
  {
    key:            'lthSopr',
    label:          'LTH SOPR (장기보유자)',
    urlCandidates:  ['/v1/lth-sopr'],
    fieldCandidates:['lthSopr', 'lth_sopr', 'value'],
    decimals:       4,
  },
  {
    key:            'sthSopr',
    label:          'STH SOPR (단기보유자)',
    urlCandidates:  ['/v1/sth-sopr'],
    fieldCandidates:['sthSopr', 'sth_sopr', 'value'],
    decimals:       4,
  },
  {
    key:            'reserveRisk',
    label:          'Reserve Risk',
    urlCandidates:  ['/v1/reserve-risk'],
    fieldCandidates:['reserveRisk', 'reserve_risk', 'value'],
    decimals:       6,
  },
];

// ── 저녁 배치 (5개, BGeometrics camelCase 엔드포인트) ──────────
// ※ 엔드포인트명: kebab-case ❌ → camelCase 복수형 ✅
// ※ 첫 실행 후 로그의 "최신 레코드" 에서 정확한 필드명 확인 가능
const EVENING_METRICS = [
  {
    key:            'netflow',
    label:          'Exchange Netflow (BTC)',
    urlCandidates:  ['/v1/exchangeNetflowBtcs'],
    fieldCandidates:['exchangeNetflowBtc', 'netflowBtc', 'netflow', 'value'],
    decimals:       0,
  },
  {
    key:            'nrpl',
    label:          'NRPL (BTC)',
    urlCandidates:  ['/v1/nrplBtcs'],
    fieldCandidates:['nrplBtc', 'nrpl', 'value'],
    decimals:       0,
  },
  {
    key:            'exchReserve',
    label:          'Exchange Reserves (BTC)',
    urlCandidates:  ['/v1/exchangeReserveBtcs'],
    fieldCandidates:['exchangeReserveBtc', 'reserveBtc', 'reserve', 'value'],
    decimals:       0,
  },
  {
    // ※ 실현시가 HODL waves — 1주~1개월 밴드 필드명은 첫 실행 로그 확인 후 수정
    key:            'utxo1m',
    label:          'UTXO 1W~1M (%)',
    urlCandidates:  ['/v1/realizedCapHodlWaveses'],
    fieldCandidates:['oneWeekToOneMonth', '1wTo1m', 'week1month1', '1w1m', 'w1m'],
    decimals:       1,
  },
  {
    // ※ 공급량 기준 HODL waves — 7년+ 밴드 필드명은 첫 실행 로그 확인 후 수정
    key:            'utxo7yr',
    label:          'UTXO 7yr+ (%)',
    urlCandidates:  ['/v1/hodlWavesSupplies'],
    fieldCandidates:['sevenYearsPlus', 'moreThan7y', '7yPlus', 'over7Years'],
    decimals:       2,
  },
  {
    // 현물 ETF 일일 순유입(USD). 양수=기관매수, 음수=기관매도
    // ※ 첫 실행 로그에서 필드명/단위(USD vs BTC) 확인 필요
    key:            'etfFlow',
    label:          'Spot ETF 순유입 (일일)',
    urlCandidates:  ['/v1/etfFlows', '/v1/etfBtcTotals'],
    fieldCandidates:['etfFlow', 'netFlow', 'flow', 'etfBtcTotal', 'total', 'value'],
    decimals:       0,
  },
];

const METRICS = BATCH === 'evening' ? EVENING_METRICS : MORNING_METRICS;

// ── 응답 배열(또는 단일 객체)에서 최신 값 추출 ───────────────
function extractLatest(data, fieldCandidates) {
  // 단일 객체 응답 처리 (일부 엔드포인트가 배열 대신 단일 객체 반환)
  if (data && !Array.isArray(data) && typeof data === 'object' && !data.error) {
    data = [data];
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  // 날짜/메타 필드 (숫자 자동탐색 제외 대상)
  const DATE_KEYS = new Set(['t', 'date', 'day', 'timestamp', 'time', 'd', 'unixTs', 'id']);

  // 날짜 필드 기준으로 내림차순 정렬 ('d' 우선)
  const sorted = [...data].sort((a, b) => {
    const da = [...DATE_KEYS].map(k => a[k]).find(v => v != null) ?? '';
    const db = [...DATE_KEYS].map(k => b[k]).find(v => v != null) ?? '';
    return String(db).localeCompare(String(da));
  });

  console.log(`   최신 레코드:`, JSON.stringify(sorted[0]));

  // 날짜 최신순으로 순회 — null 값 레코드는 건너뛰고 이전 레코드 fallback
  for (const record of sorted) {
    // 후보 필드명으로 값 탐색 — 숫자형 또는 숫자 문자열 모두 허용
    for (const f of fieldCandidates) {
      const raw = record[f];
      if (raw != null) {
        const n = parseFloat(raw);
        if (!isNaN(n)) return n;
      }
    }
    // 후보 실패 시 첫 번째 숫자형 필드 자동 탐색 (날짜·ID 제외)
    for (const [k, v] of Object.entries(record)) {
      if (!DATE_KEYS.has(k)) {
        const n = parseFloat(v);
        if (!isNaN(n) && isFinite(n)) return n;
      }
    }
    // 이 레코드에서 값 없으면 이전 날짜 레코드로 fallback
  }
  return null;
}

// ── 단일 지표 수집 ────────────────────────────────────────────
async function fetchMetric(metric) {
  // 날짜 필터 없이 최신 5개 레코드 요청
  // ※ 일부 엔드포인트(lth-sopr 등)는 무료 티어 데이터가 2026까지 없어
  //   startday/endday 필터 시 빈 배열 반환 → extractLatest가 null 리턴함
  //   날짜 필터 제거 후 extractLatest의 날짜 내림차순 정렬로 최신값 추출
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
      const value = extractLatest(data, metric.fieldCandidates);
      if (value == null) {
        console.log(`   데이터 없음 (빈 배열 또는 필드 불일치) — ${ep}`);
        continue;
      }
      const rounded = parseFloat(value.toFixed(metric.decimals));
      console.log(`   ✅ ${ep} → ${rounded}`);
      return { value: rounded, endpoint: ep };
    } catch (e) {
      console.error(`   오류: ${e.message} — ${url}`);
    }
    // 요청 간 간격 (시간당 8회 한도 준수)
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

// ── 이전 데이터 로드 (실패 시 빈 객체) ──────────────────────
function loadPrev() {
  try { return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')); }
  catch { return {}; }
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('🚀 BGeometrics 온체인 지표 수집 시작');
  console.log(`   API: ${BASE_URL} | 하루 최대 15회 | BATCH=${BATCH}\n`);

  const prev   = loadPrev();
  const result = { ...prev }; // 수집 실패한 지표는 이전 값 유지
  const log    = [];

  for (const metric of METRICS) {
    console.log(`\n📊 ${metric.label}`);
    const res = await fetchMetric(metric);
    if (res) {
      result[metric.key] = res.value;
      log.push(`  ✅ ${metric.label}: ${res.value}  (${res.endpoint})`);
    } else {
      log.push(`  ⚠️  ${metric.label}: 수집 실패 → 이전값 ${prev[metric.key] ?? '없음'} 유지`);
    }
    await new Promise(r => setTimeout(r, 1500)); // 요청 간 간격
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
