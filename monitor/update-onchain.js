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
// fieldCandidates: API 응답 객체에서 값을 찾을 필드명 후보 (우선순위 순)
// urlCandidates: 엔드포인트명 후보 (첫 번째 성공한 것 사용)
const METRICS = [
  {
    key:            'mvrvZ',
    label:          'MVRV Z-Score',
    urlCandidates:  ['/v1/mvrv', '/v1/mvrv-z-score', '/v1/mvrvz'],
    fieldCandidates:['mvrv', 'mvrv_zscore', 'mvrvz', 'value'],
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
    key:            'netflow',
    label:          'Exchange Netflow (BTC)',
    urlCandidates:  ['/v1/exchange-net-flow', '/v1/exchange-flow', '/v1/exchange-netflow', '/v1/netflow'],
    fieldCandidates:['exchangeNetFlow', 'exchangeNetflow', 'exchange_netflow', 'netflow', 'value'],
    decimals:       0,
  },
  {
    key:            'puell',
    label:          'Puell Multiple',
    urlCandidates:  ['/v1/puell-multiple', '/v1/puell_multiple', '/v1/puell'],
    fieldCandidates:['puellMultiple', 'puell_multiple', 'puell', 'value'],
    decimals:       3,
  },
  {
    key:            'funding',
    label:          'Funding Rate (%)',
    urlCandidates:  ['/v1/funding-rate', '/v1/funding_rate', '/v1/funding'],
    fieldCandidates:['fundingRate', 'funding_rate', 'funding', 'value'],
    decimals:       5,
  },
  {
    key:            'utxo1m',
    label:          'UTXO 1w~1m (실현시가총액 비율 %)',
    urlCandidates:  ['/v1/hodl-waves-realized-cap', '/v1/realized-cap-hodl-waves', '/v1/hodl_waves_realized_cap'],
    fieldCandidates:['w1_1m', '1w_1m', 'band_1w_1m', 'pct_1w_1m', 'value'],
    decimals:       2,
  },
  {
    key:            'utxo7yr',
    label:          'UTXO 7yr+ (공급량 비율 %)',
    urlCandidates:  ['/v1/hodl-waves', '/v1/hodl-waves-supply', '/v1/hodl_waves_supply'],
    fieldCandidates:['y7_10', 'y7plus', 'over7y', 'band_7y_plus', 'pct_7y_10y', 'y7_10y', 'value'],
    decimals:       2,
  },
  // ── 홀더 행동 · 사이클 국면 ─────────────────────────────────
  {
    key:            'nrpl',
    label:          'NRPL (순실현손익, BTC)',
    urlCandidates:  ['/v1/nrpl', '/v1/net-realized-pnl', '/v1/net_realized_pnl'],
    fieldCandidates:['nrpl', 'net_realized_pnl', 'value'],
    decimals:       0,
  },
  {
    key:            'exchReserve',
    label:          'Exchange Reserves (BTC)',
    urlCandidates:  ['/v1/exchange-reserve', '/v1/exchange_reserve', '/v1/exchange-reserves'],
    fieldCandidates:['exchangeReserve', 'exchange_reserve', 'reserve', 'totalReserve', 'total_reserve', 'value'],
    decimals:       0,
  },
  {
    key:            'hodlWave1y2y',
    label:          'HODL Waves 1yr-2yr (공급량 %)',
    urlCandidates:  ['/v1/hodl-waves', '/v1/hodl-waves-supply', '/v1/hodl_waves_supply'],
    fieldCandidates:['y1_2', '1y_2y', 'band_1y_2y', 'pct_1y_2y', 'y1y2', 'value'],
    decimals:       2,
  },
  {
    key:            'lthSopr',
    label:          'LTH SOPR (장기보유자)',
    urlCandidates:  ['/v1/lth-sopr', '/v1/lth_sopr', '/v1/sopr-lth'],
    fieldCandidates:['lthSopr', 'lth_sopr', 'soprLth', 'sopr_lth', 'lth', 'value'],
    decimals:       4,
  },
  {
    key:            'sthSopr',
    label:          'STH SOPR (단기보유자)',
    urlCandidates:  ['/v1/sth-sopr', '/v1/sth_sopr', '/v1/sopr-sth'],
    fieldCandidates:['sthSopr', 'sth_sopr', 'soprSth', 'sopr_sth', 'sth', 'value'],
    decimals:       4,
  },
  {
    key:            'reserveRisk',
    label:          'Reserve Risk',
    urlCandidates:  ['/v1/reserve-risk', '/v1/reserve_risk', '/v1/reserve-risk-adjusted'],
    fieldCandidates:['reserveRisk', 'reserve_risk', 'risk', 'value'],
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
  // 최근 5일 범위 (데이터 지연 대비)
  const endDay   = new Date();
  const startDay = new Date(endDay.getTime() - 5 * 86400000);
  const params   = `?startday=${fmtDate(startDay)}&endday=${fmtDate(endDay)}&size=5&sort=t,desc`;

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
