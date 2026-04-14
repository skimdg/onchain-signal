/**
 * update-onchain.js — BGeometrics API로 온체인 지표 자동 수집
 *
 * 수집 지표 (총 14개):
 *   MVRV Z-Score, NUPL, SOPR, Exchange Netflow, Puell Multiple, Funding Rate,
 *   UTXO 1w~1m, UTXO 7yr+,
 *   NRPL, Exchange Reserves, HODL Waves 1yr-2yr, LTH SOPR, STH SOPR, Reserve Risk
 *
 * API: https://bitcoin-data.com/v1/{metric}
 *      무료 · 인증 불필요 · 제한: 시간당 8회, 하루 15회 (IP 기준)
 *      ※ GitHub Actions는 실행마다 새 IP 배정 → 사실상 제한 없음
 *
 * 실행 일정 (update-onchain.yml):
 *   하루 1회 — 07:00 KST (UTC 22:00)
 *   1회당 14 요청 → 15회/일 한도 내 안전 유지
 *
 * 출력: onchain-data.json (루트, GitHub Actions이 commit)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'onchain-data.json');
const BASE_URL    = 'https://bitcoin-data.com/v1';

// ── 수집 지표 정의 ────────────────────────────────────────────
// ※ 각 지표당 URL 1개만 유지 (404 후보 제거 → 불필요한 rate limit 소모 방지)
// ※ API 제한: 시간당 8회, 하루 15회
//   1차 실행(07:00 KST, 8개): mvrv/nupl/sopr/puell/funding/netflow/nrpl/lthSopr
//   2차 실행(19:00 KST, 2개): sthSopr/reserveRisk  (일일 잔여: 15-8=7)
// ※ 404 확정 엔드포인트 (무료 티어 미제공) — 수동 입력 전용:
//   utxo1m(hodl-waves-realized-cap), utxo7yr/hodlWave1y2y(hodl-waves), exchReserve(exchange-reserve)
const METRICS = [
  // ── 1차 실행 (우선순위 순, 8개) ─────────────────────────────
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
    key:            'netflow',
    label:          'Exchange Netflow (BTC)',
    urlCandidates:  ['/v1/netflow'],
    fieldCandidates:['netflow', 'exchangeNetFlow', 'exchangeNetflow', 'value'],
    decimals:       0,
  },
  {
    key:            'nrpl',
    label:          'NRPL (순실현손익, BTC)',
    urlCandidates:  ['/v1/nrpl'],
    fieldCandidates:['nrpl', 'value'],
    decimals:       0,
  },
  {
    key:            'lthSopr',
    label:          'LTH SOPR (장기보유자)',
    urlCandidates:  ['/v1/lth-sopr'],
    fieldCandidates:['lthSopr', 'lth_sopr', 'value'],
    decimals:       4,
  },
  // ── 2차 실행 (19:00 KST, 시간당 8회 리셋 후) ─────────────────
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

// ── 날짜 헬퍼 ─────────────────────────────────────────────────
function fmtDate(d) {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── 응답 배열에서 최신 값 추출 ────────────────────────────────
function extractLatest(data, fieldCandidates) {
  if (!Array.isArray(data) || data.length === 0) return null;

  // 날짜/메타 필드 (숫자 자동탐색 제외 대상)
  const DATE_KEYS = new Set(['t', 'date', 'day', 'timestamp', 'time', 'd', 'unixTs', 'id']);

  // 날짜 필드 기준으로 내림차순 정렬 ('d' 우선)
  const sorted = [...data].sort((a, b) => {
    const da = [...DATE_KEYS].map(k => a[k]).find(v => v != null) ?? '';
    const db = [...DATE_KEYS].map(k => b[k]).find(v => v != null) ?? '';
    return String(db).localeCompare(String(da));
  });

  const latest = sorted[0];
  console.log(`   최신 레코드:`, JSON.stringify(latest));

  // 후보 필드명으로 값 탐색 — 숫자형 또는 숫자 문자열 모두 허용
  for (const f of fieldCandidates) {
    const raw = latest[f];
    if (raw != null) {
      const n = parseFloat(raw);
      if (!isNaN(n)) return n;
    }
  }
  // 후보 실패 시 첫 번째 숫자형 필드 자동 탐색 (날짜·ID 제외)
  for (const [k, v] of Object.entries(latest)) {
    if (!DATE_KEYS.has(k)) {
      const n = parseFloat(v);
      if (!isNaN(n) && isFinite(n)) return n;
    }
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
