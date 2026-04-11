/**
 * check-once.js — GitHub Actions 단발성 실행용
 * 1회 체크 후 exit. 15분마다 자동 실행 (alert.yml 스케줄).
 *
 * ENV vars:
 *   TG_TOKEN, TG_CHAT_ID (GitHub Secrets에 등록)
 */

const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

// ── 애널리스트 컨센서스 (대시보드와 동기화) ──────────────────
const ANALYSTS_AVG_BULL = 33;  // 현재 10명 평균 강세% — 대시보드 업데이트 시 맞춰 수정
const ANALYSTS_VERDICT  = '전문가 약세 우세';

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) { console.log('TG 미설정 — 콘솔 출력만:\n' + text); return; }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok) console.log('✅ Telegram 전송 성공');
  else console.error('❌ Telegram 전송 실패:', await res.text());
}

// ── 사이클 위치 간이 계산 (F&G 기반 — 대시보드는 MVRV+NUPL+F&G 가중) ──
function roughCycleLabel(fg) {
  if (fg <= 15) return { lbl:'바닥권', emoji:'🔴' };
  if (fg <= 30) return { lbl:'하락장', emoji:'🟠' };
  if (fg <= 50) return { lbl:'중립 / 회복 초기', emoji:'🟡' };
  if (fg <= 65) return { lbl:'상승 중기', emoji:'🟢' };
  return { lbl:'상승 후기 / 과열', emoji:'⚠️' };
}

// ── 전략 요약 (사이클 × 컨센서스) ────────────────────────────
function strategyHint(fg, conAvg) {
  const cyH = fg >= 65, cyL = fg <= 30;
  const coH = conAvg >= 65, coL = conAvg <= 35;
  if (cyL && coL) return '하락장+약세 — 관망 (현금 80%+)';
  if (cyL && !coH) return '하락장 — 소량 분할 매수';
  if (cyH && coH) return '과열권 — 익절 타이밍';
  if (cyH) return '상승 후기 — 부분 익절';
  return '방향성 대기 — 관망';
}

async function main() {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${now}] 체크 시작`);

  try {
    const [fgRes, btcRes] = await Promise.allSettled([
      get('https://api.alternative.me/fng/?limit=1&format=json'),
      get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true'),
    ]);

    const fg        = fgRes.status  === 'fulfilled' ? parseInt(fgRes.value.data[0].value) : null;
    const fgl       = fgRes.status  === 'fulfilled' ? fgRes.value.data[0].value_classification : '';
    const btc       = btcRes.status === 'fulfilled' ? btcRes.value.bitcoin : null;
    const btcPrice  = btc?.usd ?? null;
    const btcChange = btc?.usd_24h_change ?? null;

    console.log(`BTC $${btcPrice?.toLocaleString()} (${btcChange?.toFixed(2)}%) | F&G ${fg} ${fgl}`);

    // ── 알림 조건 평가 ──────────────────────────────────────
    const alerts = [];
    if (fg !== null) {
      if (fg <= 15) alerts.push(`🔴 <b>극도 공포</b> F&G ${fg} — 패닉 구간, 역발상 매수 타이밍`);
      else if (fg <= 25) alerts.push(`🟠 <b>공포</b> F&G ${fg} — 약세 지속, 손절선 관리`);
      if (fg >= 85) alerts.push(`🔴 <b>극도 탐욕</b> F&G ${fg} — 고점 신호, 즉시 익절 고려`);
    }
    if (btcChange !== null) {
      if (btcChange <= -10) alerts.push(`📉 <b>BTC 급락</b> 24h ${btcChange.toFixed(1)}% — 패닉 셀링 경계`);
      if (btcChange >= 10)  alerts.push(`📈 <b>BTC 급등</b> 24h +${btcChange.toFixed(1)}% — 고점 추격 주의`);
    }

    // ── 대시보드 요약 섹션 ───────────────────────────────────
    const cycle = fg != null ? roughCycleLabel(fg) : { lbl:'—', emoji:'⚪' };
    const strat = fg != null ? strategyHint(fg, ANALYSTS_AVG_BULL) : '—';
    const btcLine   = `💰 BTC <b>$${btcPrice?.toLocaleString() || '—'}</b>  ${btcChange != null ? (btcChange >= 0 ? '+' : '') + btcChange.toFixed(2) + '%' : '—'}`;
    const fgLine    = `😨 Fear&Greed <b>${fg ?? '—'}</b>  (${fgl || '—'})`;
    const cycleLine = `${cycle.emoji} 사이클 추정  <b>${cycle.lbl}</b>`;
    const conLine   = `👥 애널 컨센서스  <b>${ANALYSTS_AVG_BULL}% 강세</b>  (${ANALYSTS_VERDICT})`;
    const stratLine = `📐 전략  <b>${strat}</b>`;
    const dashLink  = `🔗 <a href="https://skimdg.github.io/onchain-signal/onchain-signal-v5.html">대시보드 열기</a>`;

    const summary = [btcLine, fgLine, cycleLine, conLine, stratLine, dashLink].join('\n');

    if (alerts.length > 0) {
      const alertBlock = alerts.join('\n');
      const msg = `🚨 <b>Onchain Signal 알림</b>\n${now}\n\n${alertBlock}\n\n─────────────────\n${summary}`;
      await sendTelegram(msg);
    } else {
      console.log('✅ 알림 조건 없음 — 정상 구간');
      // 매일 오전 9시(KST) 정기 리포트 전송
      const hour = parseInt(new Date().toLocaleString('ko-KR', { timeZone:'Asia/Seoul', hour:'numeric', hour12:false }));
      if (hour === 9) {
        const msg = `📊 <b>Onchain Signal 일일 리포트</b>\n${now}\n\n${summary}\n\n✅ 현재 알림 조건 없음`;
        await sendTelegram(msg);
      }
    }
  } catch (e) {
    console.error('오류:', e.message);
    process.exit(1);
  }

  process.exit(0);
}

main();
