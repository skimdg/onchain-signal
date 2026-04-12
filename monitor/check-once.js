/**
 * check-once.js — GitHub Actions 단발성 실행용
 * 15분마다 실행 → 이전 상태(state.json)와 비교해 변경 감지 → 텔레그램 알림
 *
 * 감지 조건:
 *   1. 애널리스트 스탠스 변경 (analyst-data.json 읽기, 15명)
 *   2. 사이클 점수 구간 변경 (0~20 / 20~40 / 40~60 / 60~75 / 75+)
 *      대시보드와 동일 공식: MVRV-Z(45%) + NUPL(35%) + F&G(20%)
 *   3. 온체인 지표 구간 변경 (F&G 자동 / 나머지 MANUAL 하드코딩)
 *   4. 즉시 경보 (F&G ≤15, F&G ≥85, BTC 24h ≤-10%, BTC 24h ≥+10%)
 *   5. 매일 07:30 KST 일일 리포트 (analyst update 완료 30분 후)
 *
 * ⚠️  온체인 지표(MVRV-Z/NUPL/SOPR/Netflow/Funding/Puell)는 Glassnode API 없이
 *     자동 수집 불가 → 대시보드에서 수동 업데이트 후 아래 MANUAL 값도 같이 수정 필요
 *
 * ENV: TG_TOKEN, TG_CHAT_ID (GitHub Secrets)
 * 상태 파일: monitor/state.json (GitHub Actions Cache로 지속)
 */

const fs   = require('fs');
const path = require('path');

const TG_TOKEN     = process.env.TG_TOKEN   || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID || '';
const STATE_PATH   = path.join(__dirname, 'state.json');
const ANALYST_PATH = path.join(__dirname, '..', 'analyst-data.json');

// ══════════════════════════════════════════════════════════════
//  ★ 수동 지표 값 — 대시보드에서 값 바꿀 때 여기도 같이 수정
//    (Glassnode/CryptoQuant 확인 후 업데이트)
// ══════════════════════════════════════════════════════════════
const MANUAL = {
  mvrvZ:   0.43,   // MVRV Z-Score
  nupl:    0.15,   // NUPL
  sopr:    0.98,   // SOPR
  netflow: -5000,  // Exchange Netflow (BTC/일)
  funding: 0.008,  // Funding Rate (%)
  puell:   0.62,   // Puell Multiple
};

// 애널리스트 이름 맵 (ID → 표시명)
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
//  사이클 점수 계산 — 대시보드 calcCycle()과 동일 공식
//  MVRV-Z(45%) + NUPL(35%) + F&G(20%)
// ══════════════════════════════════════════════════════════════
function calcCycleScore(mvrvZ, nupl, fg) {
  const z = mvrvZ, n = nupl;
  const mv  = z<0?8:z<0.5?16:z<1?25:z<1.5?34:z<2?44:z<2.5?53:z<3?61:z<3.5?68:z<4.5?76:z<6?84:92;
  const np  = n<0?8:n<0.1?18:n<0.25?28:n<0.4?42:n<0.5?55:n<0.65?68:n<0.75?78:88;
  const fg2 = fg<15?8:fg<25?18:fg<35?28:fg<45?40:fg<55?52:fg<65?62:fg<75?71:fg<85?79:86;
  return Math.round(mv * 0.45 + np * 0.35 + fg2 * 0.20);
}

// 사이클 점수 → 구간 레이블 (사용자 지정: 0~20/20~40/40~60/60~75/75+)
function cycleZone(score) {
  return score <= 20 ? '바닥권(0~20)'
       : score <= 40 ? '하락장(20~40)'
       : score <= 60 ? '회복(40~60)'
       : score <= 75 ? '상승(60~75)'
       :               '과열(75+)';
}

// ══════════════════════════════════════════════════════════════
//  온체인 지표 구간 함수
// ══════════════════════════════════════════════════════════════
function fgZone(v)      { return v<=15?'극도공포':v<=25?'공포':v<=55?'중립':v<=75?'탐욕':'극도탐욕'; }
function mvrvZone(v)    { return v<0?'극저평가':v<2?'저평가':v<3.5?'적정':v<6?'고평가':'극과열'; }
function nuplZone(v)    { return v<0?'항복':v<0.25?'희망':v<0.5?'낙관':v<0.75?'믿음':'행복'; }
function soprZone(v)    { return v<0.97?'패닉':v<1.0?'손익분기':v<1.05?'건전이익실현':'이익실현과잉'; }
function netflowZone(v) { return v<-20000?'강한유출':v<0?'순유출':v<5000?'소폭유입':'강한유입'; }
function fundingZone(v) { return v<-0.01?'숏과다':v<=0.01?'중립':v<=0.03?'롱과다':'극과열'; }
function puellZone(v)   { return v<0.5?'채굴자항복':v<0.8?'저평가':v<1.5?'적정':v<2.0?'과열주의':'극과열'; }

// ══════════════════════════════════════════════════════════════
//  STATE 읽기/쓰기
// ══════════════════════════════════════════════════════════════
function readState()    { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function writeState(s)  { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function loadAnalystData() {
  try { return JSON.parse(fs.readFileSync(ANALYST_PATH, 'utf8')); }
  catch { return null; }
}

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
  const now  = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const hour = parseInt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false }));
  const mins = new Date().getMinutes(); // 분(0~59)은 시간대 무관
  console.log(`[${now}] 체크 시작`);

  // ── 상태 / analyst-data 로드 ──
  const prev        = readState();
  const analystData = loadAnalystData(); // GitHub Actions가 매일 07:00 KST 업데이트
  const changes        = [];
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
  //  1. 즉시 경보 (임계값 초과)
  // ────────────────────────────────────────────────────────────
  if (fg !== null) {
    if (fg <= 15) immediateAlerts.push(`🔴 <b>극도 공포</b> F&amp;G ${fg} — 패닉 구간, 역발상 매수 타이밍`);
    if (fg >= 85) immediateAlerts.push(`🔴 <b>극도 탐욕</b> F&amp;G ${fg} — 고점 신호, 즉시 익절 고려`);
  }
  if (btcChange !== null) {
    if (btcChange <= -10) immediateAlerts.push(`📉 <b>BTC 급락</b> 24h ${btcChange.toFixed(1)}%`);
    if (btcChange >= 10)  immediateAlerts.push(`📈 <b>BTC 급등</b> 24h +${btcChange.toFixed(1)}%`);
  }

  // ────────────────────────────────────────────────────────────
  //  2. 사이클 점수 구간 변경 감지
  //     대시보드와 동일 공식 사용 (MVRV-Z·NUPL·F&G 가중평균)
  //     구간: 바닥권(0~20) / 하락장(20~40) / 회복(40~60) / 상승(60~75) / 과열(75+)
  // ────────────────────────────────────────────────────────────
  const cycleScore = calcCycleScore(MANUAL.mvrvZ, MANUAL.nupl, fg ?? 50);
  const curCycleZone = cycleZone(cycleScore);
  console.log(`사이클 점수: ${cycleScore} → ${curCycleZone}`);
  if (prev.cycleZone && prev.cycleZone !== curCycleZone) {
    changes.push(`🔄 <b>사이클 구간 변경</b>\n  ${prev.cycleZone} → <b>${curCycleZone}</b>  (점수 ${cycleScore})`);
  }

  // ────────────────────────────────────────────────────────────
  //  3. 온체인 지표 구간 변경 감지
  //     ⚠️ F&G만 자동 수집, 나머지는 MANUAL 하드코딩
  //        → 대시보드 값 변경 시 위 MANUAL 상수도 함께 수정 필요
  // ────────────────────────────────────────────────────────────
  const metricChecks = [
    { key: 'fg',      label: 'Fear & Greed',    cur: fg !== null ? fgZone(fg)           : null },
    { key: 'mvrv',    label: 'MVRV Z-Score',    cur: mvrvZone(MANUAL.mvrvZ)                    },
    { key: 'nupl',    label: 'NUPL',             cur: nuplZone(MANUAL.nupl)                     },
    { key: 'sopr',    label: 'SOPR',             cur: soprZone(MANUAL.sopr)                     },
    { key: 'netflow', label: 'Exchange Netflow', cur: netflowZone(MANUAL.netflow)               },
    { key: 'funding', label: 'Funding Rate',     cur: fundingZone(MANUAL.funding)               },
    { key: 'puell',   label: 'Puell Multiple',   cur: puellZone(MANUAL.puell)                   },
  ];

  for (const m of metricChecks) {
    if (!m.cur) continue;
    const prevZone = prev.zones?.[m.key];
    if (prevZone && prevZone !== m.cur) {
      changes.push(`📊 <b>${m.label} 구간 변경</b>\n  ${prevZone} → <b>${m.cur}</b>`);
    }
  }

  // ────────────────────────────────────────────────────────────
  //  4. 애널리스트 스탠스 변경 감지 (analyst-data.json, 15명)
  // ────────────────────────────────────────────────────────────
  if (analystData?.analysts?.length) {
    for (const a of analystData.analysts) {
      const curStance  = a.bullPct >= 60 ? '강세' : a.bullPct >= 40 ? '중립' : '약세';
      const prevA      = prev.analysts?.[a.id];
      if (prevA && prevA.stance !== curStance) {
        const dir  = curStance === '강세' ? '📈' : curStance === '약세' ? '📉' : '➡️';
        const name = NAME_MAP[a.id] || a.id;
        changes.push(`${dir} <b>애널리스트 포지션 변경</b> — ${name}\n  ${prevA.stance} (${prevA.bullPct}%) → <b>${curStance}</b> (${a.bullPct}%)`);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  //  알림 전송
  // ────────────────────────────────────────────────────────────
  const avgBull  = analystData?.avgBull
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
  //  5. 매일 07:30 KST 일일 리포트
  //     update-analysts.yml이 07:00 KST 실행 → 30분 후 최신 데이터로 보고
  //     alert.yml은 */15분 실행 → 07:28~07:44 슬롯에서 리포트 전송
  // ────────────────────────────────────────────────────────────
  if (hour === 7 && mins >= 28 && mins <= 44) {
    const analysts = analystData?.analysts || [];
    const bulls    = analysts.filter(a => a.bullPct >= 60);
    const neuts    = analysts.filter(a => a.bullPct >= 40 && a.bullPct < 60);
    const bears    = analysts.filter(a => a.bullPct < 40);

    // 온체인 장기 / 단기 전문 분리
    const onchainIds   = ['capriole','checkmate','kiyoungju','willclemente','bencowen','maartunn','axeladler','cryptoviz','skew','carpenoctom'];
    const shorttermIds = ['route2fi','alexkruger','crypnuevo','ecoinometrics','rektcapital'];

    const makeLines = ids => ids
      .map(id => analysts.find(a => a.id === id))
      .filter(Boolean)
      .map(a => {
        const icon = a.bullPct >= 60 ? '🟢' : a.bullPct >= 40 ? '🟡' : '🔴';
        const stance = a.bullPct >= 60 ? '강세' : a.bullPct >= 40 ? '중립' : '약세';
        const prevTxt = (a.prevBullPct != null && a.prevBullPct !== a.bullPct)
          ? ` (이전 ${a.prevBullPct}%)` : '';
        const hl = a.headlines?.[0]
          ? `\n    📰 ${a.headlines[0].replace(/^\d{4}\.\s*\d+\.\s*\d+\.\s*[—-]\s*/, '').substring(0, 65)}`
          : `\n    💬 ${(a.summary || '—').substring(0, 65)}`;
        return `${icon} <b>${NAME_MAP[a.id] || a.id}</b>  ${a.bullPct}% ${stance}${prevTxt}${hl}`;
      }).join('\n\n');

    const analystSection = analysts.length
      ? `\n\n──── 👥 애널리스트 현황 ────\n강세 ${bulls.length}명 · 중립 ${neuts.length}명 · 약세 ${bears.length}명  (평균 ${analystData?.avgBull ?? '?'}%)\n`
        + `업데이트: ${analystData?.updatedAtKST?.split(' ')[0] || '—'} 웹검색\n\n`
        + `<b>📊 온체인 장기</b>\n${makeLines(onchainIds)}\n\n`
        + `<b>⚡ 단기 전문</b>\n${makeLines(shorttermIds)}`
      : '';

    const metricSection = `\n\n──── 📈 온체인 지표 현황 ────\n`
      + metricChecks.map(m => `• ${m.label}: <b>${m.cur}</b>`).join('\n');

    const reportMsg = `📊 <b>Onchain Signal 일일 리포트</b>\n${now}\n\n${summary}${metricSection}${analystSection}\n\n`
      + (immediateAlerts.length > 0
          ? `⚠️ 활성 즉시알림: ${immediateAlerts.length}건\n` + immediateAlerts.join('\n')
          : '✅ 즉시 알림 조건 없음');

    await sendTelegram(reportMsg);
    console.log('📊 일일 리포트 전송 완료');
  }

  // ── 상태 저장 ──
  const newState = {
    cycleZone: curCycleZone,
    cycleScore,
    zones: Object.fromEntries(metricChecks.filter(m => m.cur).map(m => [m.key, m.cur])),
    // 애널리스트: ID 기준, bullPct와 stance 모두 저장
    analysts: Object.fromEntries(
      (analystData?.analysts || []).map(a => [
        a.id,
        { bullPct: a.bullPct, stance: a.bullPct >= 60 ? '강세' : a.bullPct >= 40 ? '중립' : '약세' }
      ])
    ),
    btcPrice,
    fg,
    updatedAt: new Date().toISOString(),
  };
  writeState(newState);
  console.log('💾 상태 저장 완료');
  process.exit(0);
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
