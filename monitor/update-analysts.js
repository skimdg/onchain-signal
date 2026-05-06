/**
 * update-analysts.js — Nitter RSS로 트위터 게시물 수집 후 포지션 분석
 *
 * 1차: Nitter RSS (Twitter 대체) — 해당 애널리스트의 실제 트윗 직접 파싱
 * 2차: Google News RSS 폴백 (Nitter 실패 시)
 *
 * Nitter instances (순서대로 시도):
 *   nitter.poast.org / nitter.privacydev.net / nitter.1d4.us / nitter.unixfox.eu
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'analyst-data.json');

// 전체 애널리스트 목록 (foredex TOP 10 + 단기 전문 5명)
const ANALYSTS = [
  // ── 온체인 데이터 (foredex.io TOP 10) ─────────────────────────
  { id:'dancoininvestor',  name:'Crypto Dan',      handle:'dancoininvestor',  specialty:'온체인 장기 · 사이클 분석' },
  { id:'gaah_im',          name:'Gaah',            handle:'gaah_im',          specialty:'온체인 장기 분석' },
  { id:'crypto_glass',     name:'Zizcrypto',       handle:'_crypto_glass',    specialty:'온체인 장기 · UTXO 분석' },
  { id:'abramchart',       name:'AbramChart',       handle:'abramchart',       specialty:'온체인 장기 · 차트 패턴' },
  { id:'defioasis',        name:'defioasis.eth',    handle:'defioasis',        specialty:'온체인 장기 · DeFi 분석' },
  { id:'satoureireal',     name:'Rei Researcher',   handle:'satoureireal',     specialty:'온체인 장기 연구' },
  { id:'whitepeach',       name:'백도',              handle:'whitepeach',       specialty:'온체인 · 트레이딩 분석', korean:true },
  { id:'colu_farmer',      name:'코루',              handle:'colu_farmer',      specialty:'온체인 · 포지션 전략', korean:true },
  { id:'fivedragontigger', name:'오룡타이거',         handle:'fivedragontigger', specialty:'온체인 · 포지션 관리', korean:true },
  { id:'simplspark',       name:'심플',              handle:'simplspark',       specialty:'온체인 · 단기 분석', korean:true },
  // ── 단기 전문 5명 ───────────────────────────────────────────────
  { id:'route2fi',         name:'Route 2 Fi',       handle:'Route2FI',         specialty:'단기 가격 예측 · TA 사이클' },
  { id:'alexkruger',       name:'Alex Kruger',      handle:'krugermacro',      specialty:'거시 경제 · 단기 트레이딩' },
  { id:'crypnuevo',        name:'CrypNuevo',         handle:'CrypNuevo',        specialty:'기술적 분석 · 단기 차트' },
  { id:'ecoinometrics',    name:'ecoinometrics',    handle:'ecoinometrics',    specialty:'계량 경제 · 단기 사이클' },
  { id:'rektcapital',      name:'Rekt Capital',     handle:'rektcapital',      specialty:'차트 패턴 · 지지/저항 분석' },
];

// Nitter 인스턴스 (순서대로 시도)
const NITTER_INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
  'nitter.1d4.us',
  'nitter.unixfox.eu',
  'nitter.esmailelbob.xyz',
];

// ── 감성 구문 ──────────────────────────────────────────────────
const BEAR_PHRASES = [
  'bearish', 'bear market', 'sell', 'short', 'crash', 'collapse',
  'correction', 'more downside', 'could fall', 'could drop', 'will fall',
  'fall below', 'drop to', 'before recovery', 'not yet', 'not bullish',
  'too early', 'capitulation', 'lower target', 'lower price', 'pain ahead',
  'overvalued', 'overbought', 'bubble', 'break down', 'sell off',
  'below support', 'resistance', 'rejected', 'fakeout', 'dump',
  'caution', 'warning', 'careful', 'risk', 'danger', 'be careful',
];
const BULL_PHRASES = [
  'bullish', 'buy', 'accumulate', 'long', 'bottom is in', 'bottomed',
  'found bottom', 'breakout', 'rally', 'surge', 'target of $',
  'undervalued', 'oversold', 'dip buy', 'strong buy', 'upside',
  'higher highs', 'recovery', 'trend reversal', 'bull run',
  'institutional buying', 'accumulation', 'support', 'hold',
  'buying the dip', 'add here', 'great entry', 'loading',
  'moon', 'pump', 'going up', 'going higher', 'above',
];
const KO_BEAR_PHRASES = [
  '하락', '매도', '조정', '약세', '폭락', '경고', '주의', '손절',
  '저항', '고점', '단기 고점', '돌파 실패', '위험', '반등 실패',
  '숏', '공매도', '떨어질', '내려갈', '추가 하락', '조심',
];
const KO_BULL_PHRASES = [
  '상승', '매수', '강세', '돌파', '목표가', '바닥', '반등', '축적',
  '롱', '불런', '저점', '지지', '상방', '급등', '올라갈', '살거',
  '담을', '분할 매수', '추가 매수', '올라오면', '갈 것 같',
];

// ── 이전 데이터 로드 ───────────────────────────────────────────
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
  while ((m = itemRe.exec(xml)) !== null && items.length < 20) {
    const block = m[1];
    const get = (tag) => {
      const r = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
    };
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/) ||
                      block.match(/href="([^"]+)"/);
    const title = get('title');
    if (!title) continue;
    items.push({
      title,
      desc:    get('description').substring(0, 300),
      url:     linkMatch ? linkMatch[1].trim() : '',
      pubDate: get('pubDate'),
    });
  }
  return items;
}

// ── Nitter RSS로 트윗 수집 ──────────────────────────────────────
async function fetchNitterTweets(handle) {
  for (const instance of NITTER_INSTANCES) {
    const url = `https://${instance}/${handle}/rss`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OnchainSignal/1.0)' },
        signal:  AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const xml  = await res.text();
      const items = parseRSS(xml);
      if (items.length > 0) {
        console.log(`   ✅ Nitter [${instance}] → ${items.length}개 트윗`);
        return { items, source: 'nitter' };
      }
    } catch (e) {
      console.log(`   Nitter [${instance}] 실패: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ── Google News RSS 폴백 ───────────────────────────────────────
async function fetchGoogleNews(analyst) {
  const queries = analyst.korean ? [
    `${analyst.handle} 비트코인`,
    `"${analyst.name}" 비트코인`,
  ] : [
    `"${analyst.name}" bitcoin`,
    `${analyst.handle} bitcoin`,
  ];

  const allItems = [];
  for (const q of queries) {
    try {
      const locale = analyst.korean ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en&gl=US&ceid=US:en';
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${locale}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OnchainSignal/1.0)' },
        signal:  AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const items = parseRSS(await res.text());
      items.forEach(it => {
        if (!allItems.some(x => x.title === it.title)) allItems.push(it);
      });
    } catch { /* 무시 */ }
    await new Promise(r => setTimeout(r, 600));
    if (allItems.length >= 6) break;
  }
  return allItems.length > 0 ? { items: allItems, source: 'gnews' } : null;
}

// ── 포지션 계산 ────────────────────────────────────────────────
function calcStance(items, isNitter, isKorean) {
  const now = Date.now();
  let bull = 0, bear = 0, validCount = 0;

  items.forEach(({ title, desc, pubDate }) => {
    const ageMs   = pubDate ? now - new Date(pubDate).getTime() : Infinity;
    const ageDays = ageMs / 86400000;
    if (ageDays > 60) return; // 60일 이상 제외

    const fullTxt = (title + ' ' + desc).toLowerCase();

    // Nitter(트윗)인 경우: BTC 언급 여부만 확인 (모든 트윗이 해당 애널리스트 것)
    // Google News인 경우: BTC 언급 필수 + 내용에 신호가 있어야 함
    const hasBtc = /\b(bitcoin|btc)\b/.test(fullTxt) || /비트코인|비트/.test(fullTxt);
    if (!hasBtc && !isNitter) return;
    // Nitter의 경우 BTC 언급 없어도 시장 관련 트윗 포함 (가격, 시장, 전망 등)
    if (!hasBtc && isNitter) {
      const hasMarket = /price|market|bull|bear|pump|dump|long|short|chart|target|support|resistance|상승|하락|시장|가격|차트|목표/.test(fullTxt);
      if (!hasMarket) return;
    }

    validCount++;
    const weight = ageDays < 7 ? 4 : ageDays < 14 ? 3 : ageDays < 30 ? 2 : 1;

    const negBull = /\b(not|no|never|unlikely|won't|cannot|can't|before|until)\b/.test(fullTxt);
    const negBear = /\b(not|no|never|unlikely|won't|cannot|can't)\b/.test(fullTxt);

    const matchPhrase = (t, p) => p.length <= 6
      ? new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)
      : t.includes(p);

    BEAR_PHRASES.forEach(p => {
      if (matchPhrase(fullTxt, p)) negBear ? (bull += weight * 0.5) : (bear += weight);
    });
    BULL_PHRASES.forEach(p => {
      if (matchPhrase(fullTxt, p)) negBull ? (bear += weight * 0.5) : (bull += weight);
    });
    if (isKorean) {
      KO_BEAR_PHRASES.forEach(p => { if (fullTxt.includes(p)) bear += weight; });
      KO_BULL_PHRASES.forEach(p => { if (fullTxt.includes(p)) bull += weight; });
    }
  });

  if (validCount === 0 || (bull === 0 && bear === 0)) return null;

  const total = bull + bear;
  const raw   = Math.round((bull / total) * 100);
  // 40~60 중립, 60~75 강세, 75+ 강한강세, 25~40 약세, <25 강한약세
  return Math.max(10, Math.min(90, raw));
}

// ── 헤드라인 생성 ──────────────────────────────────────────────
function buildHeadlines(items, isNitter) {
  const now = Date.now();
  return items
    .filter(it => {
      const ageMs = it.pubDate ? now - new Date(it.pubDate).getTime() : Infinity;
      return ageMs < 60 * 86400000; // 60일 이내
    })
    .slice(0, 5)
    .map(it => {
      const d = it.pubDate ? new Date(it.pubDate) : null;
      const dateStr = d ? `${d.getFullYear()}.${d.getMonth()+1}.${d.getDate()}. — ` : '';
      const text = isNitter
        ? it.title.replace(/^R to @\w+:\s*/i, '').substring(0, 80)
        : it.title.substring(0, 80);
      return dateStr + text;
    });
}

// ── 요약 생성 ──────────────────────────────────────────────────
function buildSummary(bullPct, items, isNitter) {
  if (!items || items.length === 0) return '(데이터 없음)';
  const recent = items.slice(0, 3).map(it => it.title.substring(0, 60)).join(' / ');
  const stance = bullPct >= 65 ? '강세' : bullPct >= 55 ? '약강세' : bullPct >= 45 ? '중립' : bullPct >= 35 ? '약약세' : '약세';
  return `${stance} 포지션. 최근: ${recent.substring(0, 100)}`;
}

// ── 단일 애널리스트 처리 ───────────────────────────────────────
async function processAnalyst(analyst) {
  console.log(`\n📊 ${analyst.name} (@${analyst.handle})`);
  const prev = prevData[analyst.id];

  // 1차: Nitter RSS (트위터)
  let result = await fetchNitterTweets(analyst.handle);
  let isNitter = true;

  // 2차: Google News 폴백 (한국어 핸들 제외)
  if (!result || result.items.length === 0) {
    if (analyst.korean) {
      // 한국어 핸들: Google News 검색 결과가 무관한 기사로 오염되므로 건너뜀
      console.log(`   → 한국어 핸들: Google News 건너뜀 → 이전값 유지`);
    } else {
      console.log(`   → Google News 폴백`);
      result = await fetchGoogleNews(analyst);
      isNitter = false;

      // 기사 제목/본문에 핸들명 또는 실명(첫 단어)이 포함된 것만 유효 처리
      if (result && result.items.length > 0) {
        const handle = analyst.handle.toLowerCase();
        const firstName = analyst.name.split(' ')[0].toLowerCase();
        const filtered = result.items.filter(it => {
          const t = (it.title + ' ' + (it.desc || '')).toLowerCase();
          return t.includes(handle) || t.includes(firstName);
        });
        if (filtered.length === 0) {
          console.log(`   → 기사에 애널리스트 이름 없음 → 이전값 유지`);
          result = null;
        } else {
          result.items = filtered;
        }
      }
    }
  }

  if (!result || result.items.length === 0) {
    console.log(`   ⚠️  데이터 없음 → 이전값 유지`);
    return prev ? { ...prev } : {
      id: analyst.id, bullPct: 50, summary: '(데이터 없음)', headlines: [], sourceUrls: [], lastScan: null, scanning: false,
    };
  }

  const { items } = result;
  console.log(`   [${result.source}] ${items.length}개 항목 수집`);

  const newBullPct = calcStance(items, isNitter, analyst.korean || false);
  const bullPct    = newBullPct !== null ? newBullPct : (prev?.bullPct ?? 50);

  if (newBullPct === null) {
    console.log(`   → 감성 신호 없음 → 이전값(${prev?.bullPct ?? 50}%) 유지`);
  } else {
    console.log(`   → bullPct: ${bullPct}% (bull=${newBullPct !== null ? '계산됨' : '없음'})`);
  }

  const headlines = buildHeadlines(items, isNitter);
  const sourceUrls = items.filter(it => it.url).slice(0, 3).map(it => it.url);

  return {
    id:          analyst.id,
    bullPct,
    prevBullPct: prev?.bullPct ?? null,
    summary:     buildSummary(bullPct, items, isNitter),
    headlines,
    sourceUrls,
    lastScan:    new Date().toISOString(),
    scanning:    false,
    dataSource:  result.source,
  };
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('🔍 애널리스트 포지션 수집 시작 (Nitter RSS + Google News 폴백)');
  console.log(`   대상: ${ANALYSTS.length}명\n`);

  const results = [];
  for (const analyst of ANALYSTS) {
    const r = await processAnalyst(analyst);
    results.push(r);
    await new Promise(re => setTimeout(re, 1500)); // rate limit 방지
  }

  const avgBull = Math.round(results.reduce((s, a) => s + a.bullPct, 0) / results.length);

  const output = {
    analysts:      results,
    avgBull,
    updatedAt:     new Date().toISOString(),
    updatedAtKST:  new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log('\n─────────────────────────────────');
  results.forEach(r => {
    const stance = r.bullPct >= 60 ? '🟢강세' : r.bullPct >= 40 ? '🟡중립' : '🔴약세';
    console.log(`  ${stance} ${r.id}: ${r.bullPct}% [${r.dataSource||'?'}] ${r.headlines[0]?.substring(0,50)||'뉴스 없음'}`);
  });
  console.log(`\n✅ 완료 — 평균 ${avgBull}% | ${output.updatedAtKST}`);
  process.exit(0);
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
