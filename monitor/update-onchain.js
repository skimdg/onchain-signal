/**
 * update-onchain.js — 온체인 지표 자동 수집
 *
 * ① BGeometrics (bitcoin-data.com) — 무료, API 키 불필요
 *    수집: mvrvZ, nupl, sopr, puell, funding, lthSopr, sthSopr, reserveRisk (8개)
 *
 * ② Foredex.io — Professional 플랜($50/mo), FOREDEX_API_KEY 환경변수 필요
 *    수집: exchReserve, netflow, nrpl, utxo1m, utxo7yr (5개)
 *    설정: GitHub Settings → Secrets → Actions → FOREDEX_API_KEY
 *
 * 출력: onchain-data.json (루트, GitHub Actions이 commit)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'onchain-data.json');
const BASE_URL    = 'https://bitcoin-data.com/v1';

// ── 수집 지표 정의 ────────────────────────────────────────────
// ※ API 제한: 시간당 ~7회 (IP 기준), 하루 15회
// ※ 각 지표당 URL 1개만 유지 (404도 rate limit 소모 → 낭비 제거)
//
// ※ 404 확정 (무료 티어 미제공) — 대시보드 수동 입력 전용:
//   netflow(/v1/netflow), nrpl(/v1/nrpl),
//   utxo1m(hodl-waves-realized-cap), utxo7yr/hodlWave1y2y(hodl-waves),
//   exchReserve(exchange-reserve)
//
// ※ 수집 가능 지표 8개 (순서 = 우선순위):
//   mvrv, nupl, sopr, puell, funding → 5개 안정 수집
//   lthSopr, sthSopr, reserveRisk    → 나머지 3개 (rate limit 여유 시 수집)
//
// ※ 워크플로우 2회/일:
//   07:00 KST — 상위 5개 안정 수집 + lthSopr/sthSopr 시도
//   19:00 KST — sthSopr/reserveRisk 재시도 (일일 잔여 활용)
const METRICS = [
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

// ── Foredex.io API ────────────────────────────────────────────
// FOREDEX_API_KEY 환경변수 있을 때만 실행
// GitHub Secrets에 FOREDEX_API_KEY 등록 시 활성화
const FOREDEX_BASE = 'https://api.foredex.io/external/v1';

// foredex 수집 지표 (API 키 필요)
const FOREDEX_METRICS = [
  {
    key:            'exchReserve',
    label:          'Exchange Reserves',
    endpoint:       '/exchange/reserve',
    fieldCandidates:['reserve','total','btcReserve','btcAmount','amount','value'],
    decimals:       0,
  },
  {
    key:            'netflow',
    label:          'Exchange Netflow',
    endpoint:       '/exchange/flow',
    fieldCandidates:['netflow','net_flow','netFlow','flow','value'],
    decimals:       0,
  },
  {
    key:            'nrpl',
    label:          'NRPL',
    endpoint:       '/onchain/nrpl',
    fieldCandidates:['nrpl','value'],
    decimals:       0,
  },
  {
    key:            'utxo1m',
    label:          'UTXO 1W~1M',
    // foredex 엔드포인트 명 미확인 → 응답 로그로 구조 파악
    endpoint:       '/onchain/hodl-waves',
    fieldCandidates:['utxo1m','oneWeekToOneMonth','1w1m','shortTerm','value'],
    decimals:       1,
  },
  {
    key:            'utxo7yr',
    label:          'UTXO 7yr+',
    endpoint:       '/onchain/hodl-waves',
    fieldCandidates:['utxo7yr','sevenYearPlus','7yr','longTermHodl','value'],
    decimals:       2,
  },
];

async function fetchForedex(metric) {
  const key = process.env.FOREDEX_API_KEY;
  if (!key) return null;

  const url = `${FOREDEX_BASE}${metric.endpoint}?limit=3`;
  try {
    const res = await fetch(url, {
      headers: { 'X-API-KEY': key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    console.log(`   Foredex ${metric.endpoint}: HTTP ${res.status}`);
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.log(`   오류 본문: ${errBody.slice(0, 200)}`);
      return null;
    }
    const body = await res.json();
    // 응답 구조 로그 (첫 400자) — 초기 연동 시 필드명 파악용
    console.log(`   응답 샘플:`, JSON.stringify(body).slice(0, 400));

    // 배열 또는 {data:[...]} 구조 통합 처리
    const rows = Array.isArray(body) ? body
               : (body?.data ?? body?.items ?? body?.result ?? body);
    const arr  = Array.isArray(rows) ? rows : [rows];
    const value = extractLatest(arr, metric.fieldCandidates);
    if (value != null) {
      const rounded = parseFloat(value.toFixed(metric.decimals));
      console.log(`   ✅ ${metric.key}: ${rounded}`);
      return rounded;
    }
    console.log(`   ⚠️  필드 매칭 실패 — fieldCandidates 재확인 필요`);
    return null;
  } catch (e) {
    console.log(`   오류: ${e.message}`);
    return null;
  }
}

// ── 날짜 헬퍼 ─────────────────────────────────────────────────
function fmtDate(d) {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

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
  console.log(`   API: ${BASE_URL} | 하루 최대 15회 제한\n`);

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

  // ── Foredex.io 추가 지표 (API 키 있을 때만) ─────────────────
  if (process.env.FOREDEX_API_KEY) {
    console.log('\n🔑 FOREDEX_API_KEY 감지 → Foredex.io 지표 수집 시작');
    // utxo1m/utxo7yr는 같은 엔드포인트(/onchain/hodl-waves) → 중복 요청 방지
    const seenEndpoints = new Map(); // endpoint → {body, arr}
    for (const metric of FOREDEX_METRICS) {
      console.log(`\n📊 ${metric.label} (Foredex)`);
      const value = await fetchForedex(metric);
      if (value != null) {
        result[metric.key] = value;
        log.push(`  ✅ ${metric.label}: ${value}  (foredex:${metric.endpoint})`);
      } else {
        log.push(`  ⚠️  ${metric.label}: Foredex 수집 실패`);
      }
      await new Promise(r => setTimeout(r, 800));
    }
  } else {
    console.log('\n   ℹ️  FOREDEX_API_KEY 없음 — exchReserve/netflow/nrpl/utxo 자동수집 불가');
    console.log('   설정: GitHub Settings → Secrets → Actions → FOREDEX_API_KEY 에 foredex.io API 키 등록');
    log.push('  ℹ️  Foredex: API 키 없음 (exchReserve/netflow/nrpl/utxo1m/utxo7yr 수동 유지)');
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
