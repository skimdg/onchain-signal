/**
 * update-analysts.js — API 키 없이 Google News 웹검색으로 애널리스트 포지션 수집
 *
 * 개선 사항:
 *  - 90일 이상 오래된 기사 제외, 최신(30일) 기사 3배 가중
 *  - 부정 표현 감지: "not bullish", "before recovery" 등 → 약세 처리
 *  - 애널리스트 직접 발언 구문 우선 (warns/says/predicts + 감성)
 *  - 신호 부족 시 이전 데이터 유지 (50% 기본값 남용 방지)
 *  - 출처 URL 저장 (대시보드 링크 아이콘, 텔레그램 포함)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'analyst-data.json');

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
  // ── 단기 전문 ──────────────────────────────────────────────
  { id:'route2fi',     name:'Route 2 Fi',        handle:'Route2FI',        specialty:'단기 가격 예측 · TA 사이클' },
  { id:'alexkruger',   name:'Alex Kruger',       handle:'krugermacro',     specialty:'거시 경제 · 단기 트레이딩' },
  { id:'crypnuevo',    name:'CrypNuevo',          handle:'CrypNuevo',       specialty:'기술적 분석 · 단기 차트' },
  { id:'ecoinometrics',name:'ecoinometrics',     handle:'ecoinometrics',   specialty:'계량 경제 · 단기 사이클' },
  { id:'rektcapital',  name:'Rekt Capital',      handle:'rektcapital',     specialty:'차트 패턴 · 지지/저항 분석' },
];

// ── 감성 구문 (문맥 포함 — 단일 단어 의존 탈피) ──────────────
const BEAR_PHRASES = [
  'warns', 'warning', 'caution', 'cautious', 'bearish', 'bear market',
  'sell', 'short', 'crash', 'collapse', 'correction needed', 'more downside',
  'could fall', 'could drop', 'will fall', 'fall below', 'drop to',
  'before recovery', 'before real recovery', 'not yet', 'not bullish',
  'not pumpable', 'not ready', 'too early', 'capitulation',
  'lower target', 'lower price', 'pain ahead', 'risk',
  'overvalued', 'overbought', 'bubble', 'break down', 'sell off',
  'needs to drop', 'needs to fall', 'below support',
];
const BULL_PHRASES = [
  'bullish', 'buy', 'accumulate', 'long',
  'bottom is in', 'bottomed', 'found bottom',
  'breakout confirmed', 'rally to', 'surge to', 'target of $',
  'undervalued', 'oversold', 'dip buy', 'strong buy',
  'upside ahead', 'sees upside', 'higher highs',
  'recovery confirmed', 'trend reversal', 'bull run',
  'institutional buying', 'accumulation zone',
];

let prevData = {};
try {
  const raw = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  prevData = Object.fromEntries((raw.analysts || []).map(a => [a.id, a]));
} catch { /* 첫 실행 */ }

// ── RSS XML 파싱 ───────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < 8) {
    const block = m[1];
    const get = (tag) => {
      const r = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
    };
    // <link> 태그는 특수 처리
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/) ||
                      block.match(/href="([^"]+)"/);
    const title = get('title');
    if (!title) continue;
    items.push({
      title,
      desc:    get('description').substring(0, 150),
      url:     linkMatch ? linkMatch[1].trim() : '',
      pubDate: get('pubDate'),
    });
  }
  return items;
}

// ── Google News RSS 검색 ───────────────────────────────────────
async function fetchNews(analyst) {
  // 직접 발언 위주 검색 (says/warns/predicts 포함)
  const queries = [
    `"${analyst.name}" bitcoin says OR warns OR predicts OR expects`,
    `"${analyst.name}" bitcoin bullish OR bearish`,
    `${analyst.handle} bitcoin`,
  ];

  const allItems = [];
  for (const q of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en&gl=US&ceid=US:en`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OnchainSignal/1.0)' },
        signal:  AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const items = parseRSS(await res.text());
      items.forEach(it => {
        if (!allItems.some(x => x.title === it.title)) allItems.push(it);
      });
    } catch { /* 검색 실패 무시 */ }
    await new Promise(r => setTimeout(r, 600));
    if (allItems.length >= 6) break;
  }
  return allItems;
}

// ── 스탠스 계산 — 직접 발언(제목에 이름 포함) + BTC 언급 기사만 채점 ──
// ★ 핵심 원칙:
//   1. 제목에 애널리스트 이름 또는 핸들이 없으면 무시 (간접 기사 제외)
//   2. 제목+본문에 bitcoin/btc 언급 없으면 무시 (XRP·ETH·HYPE 등 제외)
//   3. 위 두 조건을 모두 만족하는 기사가 60일 내 없으면 null 반환 (이전값 유지)
function calcStance(items, analystFirstName, analystHandle) {
  const now    = Date.now();
  const handle = analystHandle.replace('@', '').toLowerCase();
  let bull = 0, bear = 0, directRecent = 0;

  items.forEach(({ title, desc, pubDate }) => {
    const ageMs   = pubDate ? now - new Date(pubDate).getTime() : Infinity;
    const ageDays = ageMs / 86400000;
    if (ageDays > 90) return;                               // 3개월 이상 제외

    const titleLow = title.toLowerCase();
    const fullTxt  = (title + ' ' + desc).toLowerCase();

    // ① 제목에 BTC/Bitcoin 언급 필수 (다른 코인 단독 기사 차단)
    if (!/\b(bitcoin|btc)\b/.test(fullTxt)) return;

    // ② 제목에 애널리스트 이름 또는 핸들 필수 (직접 발언 기사만 인정)
    const isDirect = titleLow.includes(analystFirstName.toLowerCase())
                  || titleLow.includes(handle);
    if (!isDirect) return;

    if (ageDays < 60) directRecent++;                       // 60일 내 직접 발언 카운트

    const weight   = ageDays < 14 ? 3 : ageDays < 30 ? 2 : ageDays < 60 ? 1 : 0.5;
    const negBull  = /\b(not|no|never|unlikely|won't|cannot|can't|before|until)\b/.test(fullTxt);
    const negBear  = /\b(not|no|never|unlikely|won't|cannot|can't)\b/.test(fullTxt);

    const matchPhrase = (t, p) => p.length <= 6
      ? new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)
      : t.includes(p);

    BEAR_PHRASES.forEach(p => {
      if (matchPhrase(fullTxt, p)) negBear ? (bull += weight * 0.5) : (bear += weight);
    });
    BULL_PHRASES.forEach(p => {
      if (matchPhrase(fullTxt, p)) negBull ? (bear += weight * 0.5) : (bull += weight);
    });
  });

  // 60일 내 직접 발언 기사 없으면 신호 없음 → 이전값 유지
  if (directRecent === 0 || (bull === 0 && bear === 0)) return null;

  const raw   = (bull / (bull + bear)) * 100;
  const score = Math.round(raw * 0.6 + 50 * 0.4);  // 중립 방향 40% 회귀
  return Math.max(10, Math.min(90, score));
}

// ── 단일 애널리스트 처리 ───────────────────────────────────────
async function scanOne(analyst) {
  console.log(`\n🔍 ${analyst.name}`);
  const items    = await fetchNews(analyst);
  const firstName = analyst.name.split(' ')[0];
  const bullPct   = calcStance(items, firstName, analyst.handle);

  if (bullPct === null) {
    const prev = prevData[analyst.id];
    if (!prev) {
      return { id: analyst.id, bullPct: 50, summary: '(최근 뉴스 없음)', headlines: [], sourceUrls: [], lastScan: '—', scanning: false };
    }
    // 저장된 헤드라인으로 재분석 — 이전 (잘못된) 점수 수정
    const storedItems = (prev.headlines || []).map(h => {
      const dateMatch = h.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
      const pubDate = dateMatch
        ? new Date(`${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`).toUTCString()
        : null;
      const title = h.replace(/^\d.*?—\s*/, '').trim();
      return { title, desc: '', pubDate };
    });
    const reScore = calcStance(storedItems, firstName);
    if (reScore !== null) {
      console.log(`  ♻️  저장 헤드라인 재분석 → ${reScore >= 60 ? '강세' : reScore >= 40 ? '중립' : '약세'} ${reScore}%`);
      return { ...prev, bullPct: reScore, scanning: false };
    }
    console.log(`  ⚠️ 최신 신호 없음 → 이전 데이터 유지`);
    return { ...prev, scanning: false };
  }

  const today = new Date().toLocaleDateString('ko-KR',
    { year: 'numeric', month: '2-digit', day: '2-digit' }
  ).replace(/\.\s*/g, '.').replace(/\.$/, '');

  // 최신 기사 3개 추출 — calcStance와 동일 조건 (직접 발언 + BTC 언급)
  const handle2 = analyst.handle.replace('@', '').toLowerCase();
  const recentItems = items
    .filter(it => {
      if (!it.pubDate) return false;
      if ((Date.now() - new Date(it.pubDate).getTime()) > 90 * 86400000) return false;
      const tl  = it.title.toLowerCase();
      const txt = (it.title + ' ' + (it.desc || '')).toLowerCase();
      if (!/\b(bitcoin|btc)\b/.test(txt)) return false;    // BTC 언급 필수
      return tl.includes(firstName.toLowerCase()) || tl.includes(handle2); // 직접 발언 필수
    })
    .slice(0, 3);

  const headlines  = recentItems.map(it => {
    const d = it.pubDate ? new Date(it.pubDate).toLocaleDateString('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit' }) : '';
    return `${d} — ${it.title.substring(0, 70)}`;
  });
  const sourceUrls = recentItems.map(it => it.url).filter(Boolean);
  const summary    = recentItems[0]?.title.substring(0, 75) || prevData[analyst.id]?.summary || '(업데이트됨)';

  const stance = bullPct >= 60 ? '강세' : bullPct >= 40 ? '중립' : '약세';
  console.log(`  → ${stance} ${bullPct}%  (기사 ${recentItems.length}건)`);
  recentItems.slice(0, 2).forEach(it =>
    console.log(`     • ${it.pubDate ? new Date(it.pubDate).toLocaleDateString('ko-KR') : '?'}  ${it.title.substring(0, 70)}`)
  );

  // 이전 값 저장 — 변화가 있으면 항상 prevBullPct 보존 (대시보드 히스토리용)
  // ※ 15% 이상 변화 = check-once.js에서 텔레그램 알림 발송 기준 (별도)
  //   여기서는 ANY 변화 시 prev 저장, 이전 prev가 있으면 그것도 유지
  const oldData = prevData[analyst.id];
  const anyChange    = oldData && oldData.bullPct !== bullPct;
  const prevBullPct  = anyChange ? oldData.bullPct  : (oldData?.prevBullPct  ?? null);
  const prevSummary  = anyChange ? oldData.summary  : (oldData?.prevSummary  ?? null);

  return { id: analyst.id, bullPct, summary, headlines, sourceUrls, lastScan: today, scanning: false,
           ...(prevBullPct !== null ? { prevBullPct } : {}),
           ...(prevSummary ? { prevSummary } : {}) };
}

async function main() {
  console.log('🚀 애널리스트 웹검색 업데이트 (API 키 불필요)');

  const results = [];
  for (const analyst of ANALYSTS) {
    const result = await scanOne(analyst);
    if (result) results.push(result);
    await new Promise(r => setTimeout(r, 1500));
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
  console.log(`\n✅ ${results.length}명 완료  |  평균 강세: ${avgBull}%`);
  process.exit(0);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
