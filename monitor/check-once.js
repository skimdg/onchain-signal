/**
 * check-once.js — GitHub Actions 단발성 실행용
 * 15분마다 실행 → 이전 상태(state.json)와 비교해 변경 감지 → 텔레그램 알림
 *
 * 감지 조건:
 *   1. 사이클 위치 구간 변경 (바닥권 / 하락장 / 회복 / 상승 / 과열)
 *   2. 온체인 지표 구간 변경 (F&G, MVRV-Z, NUPL, SOPR, 펀딩비, Exchange Netflow, Puell)
 *   3. 애널리스트 스탠스 변경 (약세 / 중립 / 강세)
 *   4. 즉시 경보 조건 (F&G ≤15, F&G ≥85, BTC 24h ≤-10%, BTC 24h ≥+10%)
 *
 * ENV: TG_TOKEN, TG_CHAT_ID (GitHub Secrets)
 * 상태 파일: monitor/state.json (GitHub Actions Cache로 지속)
 */

const fs   = require('fs');
const path = require('path');

const TG_TOKEN       = process.env.TG_TOKEN   || '';
const TG_CHAT_ID     = process.env.TG_CHAT_ID || '';
const STATE_PATH     = path.join(__dirname, 'state.json');
const ANALYST_PATH   = path.join(__dirname, '..', 'analyst-data.json');

// ── analyst-data.json 읽기 (update-analysts.js가 매일 업데이트) ──
function loadAnalystData() {
  try {
    return JSON.parse(fs.readFileSync(ANALYST_PATH, 'utf8'));
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  ★ 수동 지표 값 — Glassnode/CryptoQuant 확인 후 업데이트
//  zone 변경 감지는 이 값이 바뀌면 다음 실행 시 자동 알림
// ══════════════════════════════════════════════════════════════
const MANUAL = {
  mvrvZ:    0.43,
  nupl:     0.15,
  sopr:     0.98,
  netflow:  -5000,
  funding:  0.008,
  puell:    0.62,
};

// ★ 애널리스트 현재 스탠스 — 대시보드 업데이트 시 같이 수정
const ANALYST_STANCES = {
  'Charles Edwards': { pct: 45, stance: '중립' },
  'Checkmate':       { pct: 30, stance: '약세' },
  'Ki Young Ju':     { pct: 25, stance: '약세' },
  'Will Clemente':   { pct: 40, stance: '중립' },
  'Ben Cowen':       { pct: 20, stance: '약세' },
  'Maartunn':        { pct: 28, stance: '약세' },
  'Axel Adler Jr':   { pct: 32, stance: '약세' },
  'CryptoVizArt':    { pct: 38, stance: '약세' },
  'Skew':            { pct: 30, stance: '약세' },
  'CarpeNoctom':     { pct: 42, stance: '중립' },
};

// ══════════════════════════════════════════════════════════════
//  ZONE 함수 — 각 지표의 현재 구간 반환
// ══════════════════════════════════════════════════════════════
function fgZone(v)       { return v<=15?'극도공포':v<=25?'공포':v<=55?'중립':v<=75?'탐욕':'극도탐욕'; }
function mvrvZone(v)     { return v<0?'극저평가':v<2?'저평가':v<3.5?'적정':v<6?'고평가':'극과열'; }
function nuplZone(v)     { return v<0?'항복':v<0.25?'희망':v<0.5?'낙관':v<0.75?'믿음':'행복'; }
function soprZone(v)     { return v<0.97?'패닉':v<1.0?'손익분기':v<1.05?'건전이익실현':'이익실현과잉'; }
function netflowZone(v)  { return v<-20000?'강한유출':v<0?'순유출':v<5000?'소폭유입':'강한유입'; }
function fundingZone(v)  { return v<-0.01?'숏과다':v<=0.01?'중립':v<=0.03?'롱과다':'극과열'; }
function puellZone(v)    { return v<0.5?'채굴자항복':v<0.8?'저평가':v<1.5?'적정':v<2.0?'과열주의':'극과열'; }
function cycleLabel(fg)  { return fg<=15?'바닥권':fg<=30?'하락장':fg<=50?'중립/회복초기':fg<=65?'상승중기':'상승후기/과열'; }

// ══════════════════════════════════════════════════════════════
//  STATE 읽기/쓰기
// ══════════════════════════════════════════════════════════════
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return {}; }
}
function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

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
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${now}] 체크 시작`);

  // ── 이전 상태 로드 ──
  const prev = readState();
  const changes = [];
  const immediateAlerts = [];

  // ── 실시간 데이터 수집 ──
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
    if (fg <= 15) immediateAlerts.push(`🔴 <b>극도 공포</b> F&G ${fg} — 패닉 구간, 역발상 매수 타이밍`);
    if (fg >= 85) immediateAlerts.push(`🔴 <b>극도 탐욕</b> F&G ${fg} — 고점 신호, 즉시 익절 고려`);
  }
  if (btcChange !== null) {
    if (btcChange <= -10) immediateAlerts.push(`📉 <b>BTC 급락</b> 24h ${btcChange.toFixed(1)}%`);
    if (btcChange >= 10)  immediateAlerts.push(`📈 <b>BTC 급등</b> 24h +${btcChange.toFixed(1)}%`);
  }

  // ────────────────────────────────────────────────────────────
  //  2. 사이클 위치 구간 변경 감지
  // ────────────────────────────────────────────────────────────
  if (fg !== null) {
    const curCycle = cycleLabel(fg);
    if (prev.cycle && prev.cycle !== curCycle) {
      changes.push(`🔄 <b>사이클 위치 변경</b>\n  ${prev.cycle} → <b>${curCycle}</b>  (F&G ${fg})`);
    }
  }

  // ────────────────────────────────────────────────────────────
  //  3. 온체인 지표 구간 변경 감지
  // ────────────────────────────────────────────────────────────
  const metricChecks = [
    { key: 'fg',       label: 'Fear & Greed',   cur: fg !== null ? fgZone(fg) : null },
    { key: 'mvrv',     label: 'MVRV Z-Score',   cur: mvrvZone(MANUAL.mvrvZ) },
    { key: 'nupl',     label: 'NUPL',            cur: nuplZone(MANUAL.nupl) },
    { key: 'sopr',     label: 'SOPR',            cur: soprZone(MANUAL.sopr) },
    { key: 'netflow',  label: 'Exchange Netflow',cur: netflowZone(MANUAL.netflow) },
    { key: 'funding',  label: 'Funding Rate',    cur: fundingZone(MANUAL.funding) },
    { key: 'puell',    label: 'Puell Multiple',  cur: puellZone(MANUAL.puell) },
  ];

  for (const m of metricChecks) {
    if (!m.cur) continue;
    const prevZone = prev.zones?.[m.key];
    if (prevZone && prevZone !== m.cur) {
      changes.push(`📊 <b>${m.label} 구간 변경</b>\n  ${prevZone} → <b>${m.cur}</b>`);
    }
  }

  // ────────────────────────────────────────────────────────────
  //  4. 애널리스트 스탠스 변경 감지
  // ────────────────────────────────────────────────────────────
  for (const [name, cur] of Object.entries(ANALYST_STANCES)) {
    const prevStance = prev.analysts?.[name];
    if (prevStance && prevStance !== cur.stance) {
      const dir = cur.stance === '강세' ? '📈' : cur.stance === '약세' ? '📉' : '➡️';
      changes.push(`${dir} <b>애널리스트 포지션 변경</b> — ${name}\n  ${prevStance} → <b>${cur.stance}</b> (${cur.pct}%)`);
    }
  }

  // ────────────────────────────────────────────────────────────
  //  알림 전송
  // ────────────────────────────────────────────────────────────
  const avgBull  = Math.round(Object.values(ANALYST_STANCES).reduce((s,a) => s+a.pct, 0) / Object.keys(ANALYST_STANCES).length);
  const dashLink = `🔗 <a href="https://skimdg.github.io/onchain-signal/onchain-signal-v5.html">대시보드 열기</a>`;
  const summary  = [
    `💰 BTC <b>$${btcPrice?.toLocaleString() || '—'}</b>  ${btcChange != null ? (btcChange>=0?'+':'')+btcChange.toFixed(2)+'%' : '—'}`,
    `😨 Fear&Greed <b>${fg ?? '—'}</b>  (${fgl})`,
    `${fg !== null ? (fg<=15?'🔴':fg<=30?'🟠':fg<=50?'🟡':'🟢') : '⚪'} 사이클  <b>${fg !== null ? cycleLabel(fg) : '—'}</b>`,
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

  // ── 매일 오전 9시 KST 정기 리포트 (조건과 무관하게 항상 전송) ──
  const hour = parseInt(new Date().toLocaleString('ko-KR', { timeZone:'Asia/Seoul', hour:'numeric', hour12:false }));
  if (hour === 9) {
    const analystData = loadAnalystData();
    let analystSection = '';

    if (analystData?.analysts?.length) {
      const sorted = [...analystData.analysts].sort((a, b) => a.bullPct - b.bullPct);
      const bears  = sorted.filter(a => a.bullPct < 40);
      const neuts  = sorted.filter(a => a.bullPct >= 40 && a.bullPct < 60);
      const bulls  = sorted.filter(a => a.bullPct >= 60);

      const lines = analystData.analysts.map(a => {
        const icon = a.bullPct >= 60 ? '🟢' : a.bullPct >= 40 ? '🟡' : '🔴';
        // 최신 헤드라인이 있으면 첫 번째 표시
        const hl = a.headlines?.[0]
          ? `\n    📰 ${a.headlines[0].substring(0, 70)}`
          : `\n    💬 ${a.summary || '—'}`;
        return `${icon} <b>${a.id === 'kiyoungju' ? 'Ki Young Ju' : a.headlines ? a.headlines[0]?.split('—')[0]?.trim() || a.id : a.id}</b> ${a.bullPct}%${hl}`;
      });

      // 이름 조회를 위한 맵
      const nameMap = {
        capriole:'Charles Edwards', checkmate:'Checkmate', kiyoungju:'Ki Young Ju',
        willclemente:'Will Clemente', bencowen:'Ben Cowen', maartunn:'Maartunn',
        axeladler:'Axel Adler Jr', cryptoviz:'CryptoVizArt', skew:'Skew', carpenoctom:'CarpeNoctom'
      };
      const analystLines = analystData.analysts.map(a => {
        const icon = a.bullPct >= 60 ? '🟢' : a.bullPct >= 40 ? '🟡' : '🔴';
        const hl = a.headlines?.[0]
          ? `\n    📰 ${a.headlines[0].replace(/^\d{4}\.\s*\d+\.\s*\d+\.\s*—\s*/, '').substring(0, 65)}`
          : `\n    💬 ${(a.summary || '—').substring(0, 65)}`;
        return `${icon} <b>${nameMap[a.id] || a.id}</b>  ${a.bullPct}%  (${a.bullPct>=60?'강세':a.bullPct>=40?'중립':'약세'})${hl}`;
      });

      analystSection = `\n\n──── 👥 애널리스트 현황 (${analystData.updatedAtKST?.split(' ')[0] || '—'} 웹검색) ────\n`
        + `강세 ${bulls.length}명 · 중립 ${neuts.length}명 · 약세 ${bears.length}명  (평균 ${analystData.avgBull}%)\n\n`
        + analystLines.join('\n\n');
    }

    const reportMsg = `📊 <b>Onchain Signal 일일 리포트</b>\n${now}\n\n${summary}${analystSection}\n\n`
      + (immediateAlerts.length > 0 ? `⚠️ 활성 알림: ${immediateAlerts.length}건\n` + immediateAlerts.join('\n') : '✅ 알림 조건 없음');

    await sendTelegram(reportMsg);
  }

  // ── 상태 저장 ──
  const newState = {
    cycle: fg !== null ? cycleLabel(fg) : (prev.cycle || null),
    zones: Object.fromEntries(metricChecks.filter(m => m.cur).map(m => [m.key, m.cur])),
    analysts: Object.fromEntries(Object.entries(ANALYST_STANCES).map(([n, a]) => [n, a.stance])),
    btcPrice,
    fg,
    updatedAt: new Date().toISOString(),
  };
  writeState(newState);
  console.log('💾 상태 저장 완료');
  process.exit(0);
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
