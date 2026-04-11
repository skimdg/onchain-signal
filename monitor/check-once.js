/**
 * check-once.js — GitHub Actions 단발성 실행용
 * 1회 체크 후 exit. 이전 알림 상태는 GitHub Actions cache로 관리.
 *
 * ENV vars:
 *   TG_TOKEN, TG_CHAT_ID (GitHub Secrets에 등록)
 */

const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

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

async function main() {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${now}] 체크 시작`);

  try {
    const [fgRes, btcRes] = await Promise.allSettled([
      get('https://api.alternative.me/fng/?limit=1&format=json'),
      get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true'),
    ]);

    const fg  = fgRes.status  === 'fulfilled' ? parseInt(fgRes.value.data[0].value) : null;
    const fgl = fgRes.status  === 'fulfilled' ? fgRes.value.data[0].value_classification : '';
    const btc = btcRes.status === 'fulfilled' ? btcRes.value.bitcoin : null;
    const btcPrice  = btc?.usd ?? null;
    const btcChange = btc?.usd_24h_change ?? null;

    console.log(`BTC $${btcPrice?.toLocaleString()} (${btcChange?.toFixed(2)}%) | F&G ${fg} ${fgl}`);

    // ── 알림 조건 평가 ──────────────────────────────────────
    const alerts = [];
    if (fg !== null) {
      if (fg <= 15) alerts.push(`🔴 극도 공포 F&G ${fg} — 패닉 구간, 역발상 매수 타이밍`);
      else if (fg <= 25) alerts.push(`🟠 공포 F&G ${fg} — 약세 지속, 손절선 관리`);
      if (fg >= 85) alerts.push(`🔴 극도 탐욕 F&G ${fg} — 고점 신호, 즉시 익절 고려`);
    }
    if (btcChange !== null) {
      if (btcChange <= -10) alerts.push(`📉 BTC 24h ${btcChange.toFixed(1)}% 급락 — 패닉 셀링 경계`);
      if (btcChange >= 10)  alerts.push(`📈 BTC 24h +${btcChange.toFixed(1)}% 급등 — 고점 추격 주의`);
    }

    if (alerts.length > 0) {
      const msg = `🚨 <b>Onchain Signal 알림</b>\n${now}\n\n${alerts.join('\n')}\n\n💰 BTC $${btcPrice?.toLocaleString() || '—'} (${btcChange?.toFixed(1) || '—'}%)\n😨 Fear&Greed: ${fg ?? '—'}`;
      await sendTelegram(msg);
    } else {
      console.log('✅ 알림 조건 없음 — 정상 구간');
      // 매일 오전 9시(KST) 정기 리포트만 전송
      const hour = new Date().toLocaleString('ko-KR', { timeZone:'Asia/Seoul', hour:'numeric', hour12:false });
      if (hour === '9') {
        const report = `📊 <b>Onchain Signal 일일 리포트</b>\n${now}\n\n💰 BTC $${btcPrice?.toLocaleString() || '—'} (${btcChange?.toFixed(1) || '—'}%)\n😨 Fear&Greed: ${fg ?? '—'} (${fgl})\n\n✅ 현재 알림 조건 없음`;
        await sendTelegram(report);
      }
    }
  } catch (e) {
    console.error('오류:', e.message);
    process.exit(1);
  }

  process.exit(0);
}

main();
