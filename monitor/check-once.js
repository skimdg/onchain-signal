/**
 * check-once.js — GitHub Actions 단발성 실행용
 * 15분마다 실행 → 이전 상태(state.json)와 비교해 변경 감지 → 텔레그램 알림
 *
 * 감지 조건:
 *   1. 사이클 점수 구간 변경 (0~20 / 20~40 / 40~60 / 60~75 / 75+)
 *   2. 온체인 지표 구간 변경 → "A구간 → B구간" 형식으로 전송
 *   3. 애널리스트 스탠스 변경 (15% 이상) → 변경 내역 + 최근 뉴스 헤드라인 포함
 *   4. 즉시 경보 (BTC 24h ±10%, F&G 극단값)
 *   5. 매일 07:15 KST 이후 첫 번째 실행 → "📅 정기알림" 전송
 *
 * ENV: TG_TOKEN, TG_CHAT_ID (GitHub Secrets)
 * 상태 파일: monitor/state.json
 */

const fs   = require('fs');
const path = require('path');

const TG_TOKEN      = process.env.TG_TOKEN   || '';
const TG_CHAT_ID    = process.env.TG_CHAT_ID || '';
const STATE_PATH    = path.join(__dirname, 'state.json');
const ANALYST_PATH  = path.join(__dirname, '..', 'analyst-data.json');
const ONCHAIN_PATH  = path.join(__dirname, '..', 'onchain-data.json');

// ══════════════════════════════════════════════════════════════
//  온체인 지표 로드 — onchain-data.json (update-onchain.js가 BGeometrics API로 자동 수집)
// ══════════════════════════════════════════════════════════════
const FALLBACK = {
  mvrvZ: 1.32, nupl: 0.266, sopr: 0.9978,
  netflow: -5000, funding: 0.008, puell: 0.79,
  utxo1m: null, utxo7yr: null, nrpl: null,
  exchReserve: null, hodlWave1y2y: null,
  lthSopr: null, sthSopr: null, reserveRisk: null,
};

function loadOnchainData() {
  try {
    const d = JSON.parse(fs.readFileSync(ONCHAIN_PATH, 'utf8'));
    console.log(`📊 온체인 데이터 로드: ${d.updatedAtKST || d.updatedAt || '날짜 불명'}`);
    return {
      mvrvZ:       d.mvrvZ       ?? FALLBACK.mvrvZ,
      nupl:        d.nupl        ?? FALLBACK.nupl,
      sopr:        d.sopr        ?? FALLBACK.sopr,
      netflow:     d.netflow     ?? FALLBACK.netflow,
      funding:     d.funding     ?? FALLBACK.funding,
      puell:       d.puell       ?? FALLBACK.puell,
      utxo1m:      d.utxo1m      ?? null,
      utxo7yr:     d.utxo7yr     ?? null,
      nrpl:        d.nrpl        ?? null,
      exchReserve: d.exchReserve ?? null,
      hodlWave1y2y:d.hodlWave1y2y?? null,
      lthSopr:     d.lthSopr     ?? null,
      sthSopr:     d.sthSopr     ?? null,
      reserveRisk: d.reserveRisk ?? null,
    };
  } catch {
    console.warn('⚠️  onchain-data.json 없음 → 폴백값 사용');
    return { ...FALLBACK };
  }
}

const MANUAL = loadOnchainData();

// 애널리스트 이름 맵
const NAME_MAP = {
  capriole:     'Charles Edwards',
  checkmate:    'Checkmate',
  kiyoungju:    'Ki Young Ju',
  willclemente: 'Will Clemente',
  bencowen:     'Ben Cowen',
  maartunn:     'Maartunn',
  axeladler:    'Axel Adler Jr',
  cryptoviz:    'CryptoVizArt',
  skew:         'Skew',
  carpenoctom:  'CarpeNoctom',
  route2fi:     'Route 2 Fi',
  alexkruger:   'Alex Kruger',
  crypnuevo:    'CrypNuevo',
  ecoinometrics:'ecoinometrics',
  rektcapital:  'Rekt Capital',
};

// ══════════════════════════════════════════════════════════════
//  사이클 점수 계산
// ══════════════════════════════════════════════════════════════
function calcCycleScore(mvrvZ, nupl, fg) {
  const z = mvrvZ, n = nupl;
  const mv  = z<0?8:z<0.5?16:z<1?25:z<1.5?34:z<2?44:z<2.5?53:z<3?61:z<3.5?68:z<4.5?76:z<6?84:92;
  const np  = n<0?8:n<0.1?18:n<0.25?28:n<0.4?42:n<0.5?55:n<0.65?68:n<0.75?78:88;
  const fg2 = fg<15?8:fg<25?18:fg<35?28:fg<45?40:fg<55?52:fg<65?62:fg<75?71:fg<85?79:86;
  return Math.round(mv * 0.45 + np * 0.35 + fg2 * 0.20);
}

function cycleZone(score) {
  return score <= 20 ? '바닥권(0~20)'
       : score <= 40 ? '하락장(20~40)'
       : score <= 60 ? '회복(40~60)'
       : score <= 75 ? '상승(60~75)'
       :               '과열(75+)';
}

// ══════════════════════════════════════════════════════════════
//  온체인 지표 구간 함수 — metricSt()와 동일 기준
// ══════════════════════════════════════════════════════════════
function fgZone(v)          { return v<=24?'극도공포':v<=49?'공포':v<=54?'중립':v<=75?'탐욕':'극도탐욕'; }
function mvrvZone(v)        { return v<0?'극저평가':v<2?'저평가':v<4?'공정가치':v<7?'고평가':'극과열'; }
function nuplZone(v)        { return v<0?'항복(Capitulation)':v<0.25?'희망(Hope)':v<0.5?'낙관(Optimism)':v<0.75?'믿음(Belief)':'행복(Euphoria)'; }
function soprZone(v)        { return v<0.95?'패닉매도':v<1.0?'손익분기':v<1.05?'건전이익실현':'이익실현과잉'; }
function netflowZone(v)     { return v<-15000?'강유출':v<-3000?'유출':v<=3000?'중립':v<=15000?'유입':'강유입'; }
function fundingZone(v)     { return v<-0.05?'숏과다':v<0?'약베어':v<=0.03?'중립':v<=0.1?'롱주의':'극과열'; }
function puellZone(v)       { return v<0.5?'채굴자항복':v<1.0?'저평가':v<3.0?'중립':v<4.0?'과열주의':'극과열'; }
function lthSoprZone(v)     { return v<0.9?'LTH항복':v<1.0?'LTH손실':v<1.5?'초기상승':v<2.5?'중기':v<4.0?'후기경고':'분배'; }
function reserveRiskZone(v) { return v<0.002?'강력매수':v<0.005?'매수':v<0.01?'중립':v<0.02?'주의':'분배'; }
function nrplZone(v)        { return v<-30000?'극도패닉':v<0?'손실실현':v<=20000?'중립':v<=80000?'이익실현':'강한분배'; }
function exchReserveZone(v) { return v<2e6?'강한축적':v<2.3e6?'축적중':v<2.6e6?'중립':v<2.9e6?'증가주의':'분배압력'; }
function utxo1mZone(v)      { return v<5?'강HODL':v<8?'건전':v<12?'보통':v<18?'과열':'분배'; }
function utxo7yrZone(v)     { return v>35?'극강홀딩':v>30?'강한홀딩':v>25?'정상':v>20?'감소':'대규모이동'; }
function sthSoprZone(v)     { return v<0.95?'STH패닉':v<1.0?'손익분기':v<1.05?'건전':'과잉'; }

// ══════════════════════════════════════════════════════════════
//  STATE 읽기/쓰기
// ══════════════════════════════════════════════════════════════
function readState()   { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function loadAnalystData() { try { return JSON.parse(fs.readFileSync(ANALYST_PATH, 'utf8')); } catch { return null; } }

// ══════════════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════════════
async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) { console.log('TG 미설정:\n' + text); return; }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok) console.log('✅ Telegram 전송 성공');
  else console.error('❌ 전송 실패:', await res.text());
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  const nowDate  = new Date();
  const now      = nowDate.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const hour     = parseInt(nowDate.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false }));
  const mins     = nowDate.getMinutes();
  const todayKST = nowDate.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${now}] 체크 시작`);

  const prev        = readState();
  const analystData = loadAnalystData();
  const changes     = [];
  const immediateAlerts = [];

  // ── 실시간 데이터 수집 (F&G, BTC) ──
  const [fgRes, btcRes] = await Promise.allSettled([
    get('https://api.alternative.me/fng/?limit=1&format=json'),
    get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true'),
  ]);

  const fg        = fgRes.status  === 'fulfilled' ? parseInt(fgRes.value.data[0].value) : null;
  const fgl       = fgRes.status  === 'fulfilled' ? fgRes.value.data[0].value_classification : '';
  const btc       = btcRes.status === 'fulfilled' ? btcRes.value.bitcoin : null;
  const btcPrice  = btc?.usd ?? null;
  const btcChange = btc?.usd_24h_change ?? null;
  console.log(`BTC $${btcPrice?.toLocaleString()} (${btcChange?.toFixed(2)}%) | F&G ${fg} ${fgl}`);

  // ────────────────────────────────────────────────────────────
  //  1. 즉시 경보
  // ────────────────────────────────────────────────────────────
  if (fg !== null) {
    if (fg <= 15) immediateAlerts.push(`🔴 <b>극도 공포</b> F&amp;G ${fg} — 패닉 구간, 역발상 매수 타이밍`);
    if (fg >= 85) immediateAlerts.push(`🔴 <b>극도 탐욕</b> F&amp;G ${fg} — 고점 신호, 즉시 익절 고려`);
  }
  if (btcChange !== null) {
    if (btcChange <= -10) immediateAlerts.push(`📉 <b>BTC 급락</b> 24h ${btcChange.toFixed(1)}%`);
    if (btcChange >=  10) immediateAlerts.push(`📈 <b>BTC 급등</b> 24h +${btcChange.toFixed(1)}%`);
  }

  // ────────────────────────────────────────────────────────────
  //  2. 사이클 점수 구간 변경 감지
  // ────────────────────────────────────────────────────────────
  const cycleScore   = calcCycleScore(MANUAL.mvrvZ, MANUAL.nupl, fg ?? 50);
  const curCycleZone = cycleZone(cycleScore);
  console.log(`사이클 점수: ${cycleScore} → ${curCycleZone}`);
  if (prev.cycleZone && prev.cycleZone !== curCycleZone) {
    changes.push(`🔄 <b>사이클 구간 변경</b>\n  ${prev.cycleZone} → <b>${curCycleZone}</b>  (점수 ${cycleScore})`);
  }

  // ────────────────────────────────────────────────────────────
  //  3. 온체인 지표 구간 변경 감지
  //     → "이전구간 → 현재구간" 형식으로 알림
  // ────────────────────────────────────────────────────────────
  const metricChecks = [
    { key: 'fg',          label: 'Fear &amp; Greed',    val: fg,                    zoneFn: fgZone          },
    { key: 'mvrv',        label: 'MVRV Z-Score',        val: MANUAL.mvrvZ,          zoneFn: mvrvZone        },
    { key: 'nupl',        label: 'NUPL',                val: MANUAL.nupl,           zoneFn: nuplZone        },
    { key: 'sopr',        label: 'SOPR',                val: MANUAL.sopr,           zoneFn: soprZone        },
    { key: 'netflow',     label: 'Exchange Netflow',    val: MANUAL.netflow,        zoneFn: netflowZone     },
    { key: 'funding',     label: 'Funding Rate',        val: MANUAL.funding,        zoneFn: fundingZone     },
    { key: 'puell',       label: 'Puell Multiple',      val: MANUAL.puell,          zoneFn: puellZone       },
    { key: 'lthSopr',     label: 'LTH SOPR',            val: MANUAL.lthSopr,        zoneFn: lthSoprZone     },
    { key: 'sthSopr',     label: 'STH SOPR',            val: MANUAL.sthSopr,        zoneFn: sthSoprZone     },
    { key: 'reserveRisk', label: 'Reserve Risk',        val: MANUAL.reserveRisk,    zoneFn: reserveRiskZone },
    { key: 'nrpl',        label: 'NRPL',                val: MANUAL.nrpl,           zoneFn: nrplZone        },
    { key: 'exchReserve', label: 'Exchange Reserves',   val: MANUAL.exchReserve,    zoneFn: exchReserveZone },
    { key: 'utxo1m',      label: 'UTXO 1w~1m',          val: MANUAL.utxo1m,         zoneFn: utxo1mZone      },
    { key: 'utxo7yr',     label: 'UTXO 7yr+',           val: MANUAL.utxo7yr,        zoneFn: utxo7yrZone     },
  ].map(m => ({ ...m, cur: m.val != null ? m.zoneFn(m.val) : null }));

  for (const m of metricChecks) {
    if (!m.cur) continue;
    const prevZone = prev.zones?.[m.key];
    if (prevZone && prevZone !== m.cur) {
      const valStr = typeof m.val === 'number'
        ? (m.val > 1000 ? m.val.toLocaleString('en-US', {maximumFractionDigits:0})
           : m.val.toFixed(m.val < 0.01 ? 5 : m.val < 1 ? 3 : 2))
        : m.val;
      changes.push(`📊 <b>${m.label} 구간 변경</b>\n  <s>${prevZone}</s> → <b>${m.cur}</b>  (값: ${valStr})`);
    }
  }

  // ────────────────────────────────────────────────────────────
  //  4. 애널리스트 스탠스 변경 감지 (15% 이상)
  //     → 이름, 이전%, 현재%, 최근 헤드라인 포함
  // ────────────────────────────────────────────────────────────
  if (analystData?.analysts?.length) {
    for (const a of analystData.analysts) {
      const curStance  = a.bullPct >= 60 ? '강세' : a.bullPct >= 40 ? '중립' : '약세';
      const prevA      = prev.analysts?.[a.id];
      if (!prevA) continue;
      const diff = Math.abs(prevA.bullPct - a.bullPct);
      if (diff < 15) continue;

      const dir  = curStance === '강세' ? '📈' : curStance === '약세' ? '📉' : '➡️';
      const name = NAME_MAP[a.id] || a.id;
      const pctStr = `${prevA.bullPct}% ${prevA.stance} → <b>${a.bullPct}% ${curStance}</b>`;
      const headline = a.headlines?.[0]
        ? `\n  📰 ${a.headlines[0].replace(/^\d{4}\.\s*\d+\.\s*\d+\.\s*[—-]\s*/, '').substring(0, 70)}`
        : (a.summary ? `\n  💬 ${a.summary.substring(0, 70)}` : '');
      changes.push(`${dir} <b>애널리스트 포지션 변경</b> — ${name}\n  ${pctStr}${headline}`);
    }
  }

  // ────────────────────────────────────────────────────────────
  //  알림 전송
  // ────────────────────────────────────────────────────────────
  const avgBull = analystData?.avgBull
    ?? Math.round((analystData?.analysts || []).reduce((s,a) => s+a.bullPct, 0) / (analystData?.analysts?.length || 1));
  const dashLink = `🔗 <a href="https://skimdg.github.io/onchain-signal/onchain-signal-v5.html">대시보드 열기</a>`;
  const summary  = [
    `💰 BTC <b>$${btcPrice?.toLocaleString() || '—'}</b>  ${btcChange != null ? (btcChange>=0?'+':'')+btcChange.toFixed(2)+'%' : '—'}`,
    `😨 Fear&amp;Greed <b>${fg ?? '—'}</b>  (${fgl})`,
    `🔄 사이클 점수  <b>${cycleScore}</b>  <i>${curCycleZone}</i>`,
    `👥 애널 컨센서스  <b>${avgBull}% 강세</b>`,
    dashLink,
  ].join('\n');

  if (immediateAlerts.length > 0) {
    const msg = `🚨 <b>Onchain Signal 즉시 알림</b>\n${now}\n\n${immediateAlerts.join('\n')}\n\n─────────────────\n${summary}`;
    await sendTelegram(msg);
  }

  if (changes.length > 0) {
    const msg = `🔔 <b>Onchain Signal 구간 변경 감지</b>\n${now}\n\n${changes.join('\n\n')}\n\n─────────────────\n${summary}`;
    await sendTelegram(msg);
  }

  if (immediateAlerts.length === 0 && changes.length === 0) {
    console.log('✅ 변경 없음 — 정상 구간');
  }

  // ────────────────────────────────────────────────────────────
  //  5. 매일 07:15 KST 이후 첫 번째 실행 → 📅 정기알림
  // ────────────────────────────────────────────────────────────
  const shouldReport = hour === 7 && mins >= 15 && prev.lastReportDate !== todayKST;
  if (shouldReport) {
    const analysts = analystData?.analysts || [];
    const bulls    = analysts.filter(a => a.bullPct >= 60);
    const neuts    = analysts.filter(a => a.bullPct >= 40 && a.bullPct < 60);
    const bears    = analysts.filter(a => a.bullPct < 40);

    const onchainIds   = ['capriole','checkmate','kiyoungju','willclemente','bencowen','maartunn','axeladler','cryptoviz','skew','carpenoctom'];
    const shorttermIds = ['route2fi','alexkruger','crypnuevo','ecoinometrics','rektcapital'];

    const makeLines = ids => ids
      .map(id => analysts.find(a => a.id === id))
      .filter(Boolean)
      .map(a => {
        const icon  = a.bullPct >= 60 ? '🟢' : a.bullPct >= 40 ? '🟡' : '🔴';
        const stance = a.bullPct >= 60 ? '강세' : a.bullPct >= 40 ? '중립' : '약세';
        const prevTxt = (a.prevBullPct != null && a.prevBullPct !== a.bullPct)
          ? ` <s>${a.prevBullPct}%</s>→` : '';
        const headline = a.headlines?.[0]
          ? `\n    📰 ${a.headlines[0].replace(/^\d{4}\.\s*\d+\.\s*\d+\.\s*[—-]\s*/, '').substring(0, 65)}`
          : `\n    💬 ${(a.summary || '—').substring(0, 65)}`;
        return `${icon} <b>${NAME_MAP[a.id] || a.id}</b> ${prevTxt} ${a.bullPct}% ${stance}${headline}`;
      }).join('\n\n');

    const analystSection = analysts.length
      ? `\n\n──── 👥 애널리스트 현황 ────\n강세 ${bulls.length}명 · 중립 ${neuts.length}명 · 약세 ${bears.length}명  (평균 ${analystData?.avgBull ?? '?'}%)\n`
        + `업데이트: ${analystData?.updatedAtKST?.split(' ')[0] || '—'} 웹검색\n\n`
        + `<b>📊 온체인 장기</b>\n${makeLines(onchainIds)}\n\n`
        + `<b>⚡ 단기 전문</b>\n${makeLines(shorttermIds)}`
      : '';

    const metricLines = metricChecks
      .filter(m => m.cur)
      .map(m => `• ${m.label}: <b>${m.cur}</b>`)
      .join('\n');
    const metricSection = `\n\n──── 📈 온체인 지표 현황 ────\n${metricLines}`;

    const reportMsg = `📅 <b>Onchain Signal 정기알림</b>\n${now}\n\n${summary}${metricSection}${analystSection}\n\n`
      + (immediateAlerts.length > 0
          ? `⚠️ 활성 즉시알림: ${immediateAlerts.length}건\n` + immediateAlerts.join('\n')
          : '✅ 즉시 알림 조건 없음');

    await sendTelegram(reportMsg);
    console.log('📅 정기알림 전송 완료');
  }

  // ── 상태 저장 ──
  const newState = {
    cycleZone:  curCycleZone,
    cycleScore,
    zones: Object.fromEntries(
      metricChecks.filter(m => m.cur).map(m => [m.key, m.cur])
    ),
    analysts: Object.fromEntries(
      (analystData?.analysts || []).map(a => [
        a.id,
        { bullPct: a.bullPct, stance: a.bullPct >= 60 ? '강세' : a.bullPct >= 40 ? '중립' : '약세' }
      ])
    ),
    btcPrice,
    fg,
    lastReportDate: shouldReport ? todayKST : (prev.lastReportDate || null),
    updatedAt: new Date().toISOString(),
  };
  writeState(newState);
  console.log('💾 상태 저장 완료');
  process.exit(0);
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
