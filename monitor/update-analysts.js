/**
 * update-analysts.js — API 키 없이 웹 검색으로 애널리스트 포지션 자동 업데이트
 * GitHub Actions에서 매일 08:00 KST 실행
 *
 * 동작:
 *   1. Google News RSS에서 각 애널리스트 최근 뉴스 수집
 *   2. 불/베어 키워드 분석으로 스탠스 결정
 *   3. analyst-data.json 저장 (대시보드 + 텔레그램 일일 리포트에서 활용)
 *
 * 필요한 API 키: 없음 (완전 무료)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'analyst-data.json');

// ── 애널리스트 목록 ────────────────────────────────────────────
const ANALYSTS = [
  { id:'capriole',     name:'Charles Edwards', handle:'caprioleio',      specialty:'해시 리본 · 온체인 정량 모델' },
  { id:'checkmate',    name:'Checkmate',        handle:'_Checkmatey_',    specialty:'UTXO · 사이클 온체인 분석' },
  { id:'kiyoungju',    name:'Ki Young Ju',      handle:'ki_young_ju',     specialty:'거래소 플로우 · 고래 추적' },
  { id:'willclemente', name:'Will Clemente',    handle:'WClementeIII',    specialty:'기관 온체인 · 수요 분석' },
  { id:'bencowen',     name:'Ben Cowen',        handle:'intocryptoverse', specialty:'수학 사이클 · 확률 기반 모델' },
  { id:'maartunn',     name:'Maartunn',          handle:'JA_Maartun',      specialty:'OI · 레버리지 분석' },
  { id:'axeladler',    name:'Axel Adler Jr',    handle:'AxelAdlerJr',     specialty:'거시 경제 + 온체인 통합' },
  { id:'cryptoviz',    name:'CryptoVizArt',     handle:'CryptovizArt',    specialty:'알트코인 · 네트워크 지표' },
  { id:'skew',         name:'Skew',              handle:'52kskew',         specialty:'파생상품 · OI 심층 분석' },
  { id:'carpenoctom',  name:'CarpeNoctom',       handle:'CarpeNoctom',     specialty:'포지션 트레이딩 · 거시 전략' },
];

// ── 감성 키워드 ────────────────────────────────────────────────
const BULL = ['bull','bullish','buy','long','bottom','accumulate','recover','breakout',
              'upside','higher','support','rebound','bounce','pump','target','potential',
              'opportunity','undervalued','cheap','dip','accumulation','hodl'];
const BEAR = ['bear','bearish','sell','short','top','correction','crash','down','lower',
              'dump','decline','weak','warning','risk','drop','fall','collapse','danger',
              'sell-off','caution','resistance','overvalued','bubble','capitulation'];

// ── 이전 데이터 로드 (스캔 실패 시 유지용) ───────────────────
let prevData = {};
try {
  const raw = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  prevData = Object.fromEntries((raw.analysts || []).map(a => [a.id, a]));
} catch { /* 첫 실행 */ }

// ── Google News RSS 검색 ───────────────────────────────────────
async function fetchNews(analyst) {
  const queries = [
    `"${analyst.name}" bitcoin`,
    `${analyst.handle} bitcoin crypto`,
  ];

  const items = [];
  for (const q of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en&gl=US&ceid=US:en`;
      const res  = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OnchainBot/1.0)' },
        signal:  AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const xml = await res.text();

      // RSS <item> 파싱
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRe.exec(xml)) !== null && items.length < 6) {
        const block = m[1];
        const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
        const descMatch  = block.match(/<description>([\s\S]*?)<\/description>/);
        const dateMatch  = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        if (!titleMatch) continue;

        const title = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim();
        const desc  = descMatch
          ? descMatch[1].replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim().substring(0, 120)
          : '';
        const pub   = dateMatch ? new Date(dateMatch[1]).toLocaleDateString('ko-KR') : '';

        if (title && !items.some(i => i.title === title)) {
          items.push({ title, desc, pub });
        }
      }
    } catch (e) { /* 검색 실패 무시 */ }

    if (items.length >= 4) break;
    await new Promise(r => setTimeout(r, 800)); // 두 번째 검색 딜레이
  }
  return items;
}

// ── 키워드 기반 스탠스 계산 ────────────────────────────────────
function calcStance(items) {
  if (items.length === 0) return null;

  let bull = 0, bear = 0;
  items.forEach(({ title, desc }) => {
    const txt = (title + ' ' + desc).toLowerCase();
    BULL.forEach(w => { if (txt.includes(w)) bull++; });
    BEAR.forEach(w => { if (txt.includes(w)) bear++; });
  });

  const total = bull + bear;
  if (total === 0) return 50; // 중립

  // 원시 비율에 회귀(중립 방향)를 적용해 극단값 방지
  const raw = (bull / total) * 100;
  return Math.round(raw * 0.7 + 50 * 0.3); // 중립 30% 혼합
}

// ── 헤드라인 한 줄 요약 (최신 뉴스 제목 기반) ─────────────────
function makeSummary(items, bullPct) {
  if (items.length === 0) return '(최근 뉴스 없음)';
  const top = items[0].title.substring(0, 70);
  // 제목이 이미 충분히 의미 있으면 그대로 사용
  return top.length > 20 ? top : items[1]?.title.substring(0, 70) || top;
}

// ── 단일 애널리스트 스캔 ───────────────────────────────────────
async function scanOne(analyst) {
  console.log(`\n🔍 ${analyst.name} (@${analyst.handle})`);
  const items  = await fetchNews(analyst);
  const rawPct = calcStance(items);

  if (rawPct === null) {
    console.log(`  ⚠️ 뉴스 없음 — 이전 데이터 유지`);
    const prev = prevData[analyst.id];
    return prev ? { ...prev, scanning: false } : null;
  }

  const bullPct = rawPct;
  const stance  = bullPct >= 60 ? '강세' : bullPct >= 40 ? '중립' : '약세';
  const summary = makeSummary(items, bullPct);
  const today   = new Date().toLocaleDateString('ko-KR',
    { year:'numeric', month:'2-digit', day:'2-digit' }
  ).replace(/\.\s*/g, '.').replace(/\.$/, '');

  console.log(`  ${stance} ${bullPct}%  |  뉴스 ${items.length}건`);
  items.slice(0, 2).forEach(it => console.log(`    • ${it.pub}  ${it.title}`));

  return {
    id:       analyst.id,
    bullPct,
    summary:  summary.substring(0, 80),
    headlines: items.slice(0, 3).map(it => `${it.pub} — ${it.title}`),
    lastScan: today,
    scanning: false,
  };
}

// ── 메인 ──────────────────────────────────────────────────────
async function main() {
  console.log('🚀 애널리스트 웹 검색 업데이트 시작 (API 키 불필요)');
  console.log(`   대상: ${ANALYSTS.length}명\n`);

  const results = [];
  for (const analyst of ANALYSTS) {
    const result = await scanOne(analyst);
    if (result) results.push(result);
    await new Promise(r => setTimeout(r, 1500)); // 요청 간격
  }

  if (results.length === 0) {
    console.error('❌ 모든 스캔 실패');
    process.exit(1);
  }

  const avgBull = Math.round(results.reduce((s, a) => s + a.bullPct, 0) / results.length);
  const output  = {
    analysts:     results,
    avgBull,
    updatedAt:    new Date().toISOString(),
    updatedAtKST: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    method:       'web-search',
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✅ 완료: ${results.length}/${ANALYSTS.length}명  |  평균 강세: ${avgBull}%`);
  process.exit(0);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
