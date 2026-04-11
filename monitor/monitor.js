/**
 * Onchain Signal Monitor — 24/7 Cloud Alert Service
 * Deploy on Render.com (free) or Railway
 *
 * ENV vars required:
 *   TG_TOKEN   — Telegram Bot Token (from @BotFather)
 *   TG_CHAT_ID — Telegram Chat ID (personal or group; prefix group with -)
 *   INTERVAL_MIN — check interval in minutes (default: 5)
 */

const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const INTERVAL   = (parseInt(process.env.INTERVAL_MIN) || 5) * 60 * 1000;

// ── State ──────────────────────────────────────────────────────
let lastAlertKeys = new Set();
let lastBtcPrice  = null;

// ── Fetch helpers ──────────────────────────────────────────────
async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchData() {
  const [fgRes, btcRes] = await Promise.allSettled([
    get('https://api.alternative.me/fng/?limit=1&format=json'),
    get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true'),
  ]);

  const fg  = fgRes.status  === 'fulfilled' ? parseInt(fgRes.value.data[0].value) : null;
  const btc = btcRes.status === 'fulfilled' ? btcRes.value.bitcoin : null;

  return { fg, btcPrice: btc?.usd ?? null, btcChange: btc?.usd_24h_change ?? null };
}

// ── Alert rules ────────────────────────────────────────────────
function buildAlerts({ fg, btcPrice, btcChange }) {
  const al = [];

  if (fg !== null) {
    if (fg <= 15) al.push({ key: `fg_panic_${Math.floor(fg/5)}`,   emoji: '🔴', msg: `시장 극도 공포 (F&G ${fg}) — 패닉 구간. 추가 하락 위험` });
    else if (fg <= 25) al.push({ key: `fg_fear_${Math.floor(fg/5)}`, emoji: '🟠', msg: `시장 공포 (F&G ${fg}) — 약세 지속, 손절선 관리` });
    if (fg >= 85) al.push({ key: `fg_greed_${Math.floor(fg/5)}`,    emoji: '🔴', msg: `시장 극도 탐욕 (F&G ${fg}) — 고점 신호, 즉시 익절` });
  }

  if (btcChange !== null) {
    if (btcChange <= -10) al.push({ key: `btc_drop_${Math.floor(btcChange/5)}`, emoji: '🔴', msg: `BTC 24h ${btcChange.toFixed(1)}% 급락 — 패닉 셀링 경계` });
    if (btcChange >= 10)  al.push({ key: `btc_pump_${Math.floor(btcChange/5)}`, emoji: '📍', msg: `BTC 24h +${btcChange.toFixed(1)}% 급등 — 고점 추격 주의` });
  }

  return al;
}

// ── Telegram ───────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('Telegram send failed:', e.message);
  }
}

// ── Main loop ──────────────────────────────────────────────────
async function check() {
  const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  try {
    const data = await fetchData();
    const alerts = buildAlerts(data);

    // BTC 가격 5% 이상 변동 시 알림
    if (lastBtcPrice && data.btcPrice) {
      const chg = ((data.btcPrice - lastBtcPrice) / lastBtcPrice) * 100;
      if (Math.abs(chg) >= 5) {
        const dir = chg > 0 ? '📈 급등' : '📉 급락';
        alerts.push({ key: `btc_move_${Date.now()}`, emoji: chg > 0 ? '📈' : '📉',
          msg: `BTC ${dir} ${chg.toFixed(1)}% (${lastBtcPrice.toLocaleString()} → $${data.btcPrice.toLocaleString()})` });
      }
    }
    lastBtcPrice = data.btcPrice ?? lastBtcPrice;

    // 새 알림만 필터링해서 전송
    const newAlerts = alerts.filter(a => !lastAlertKeys.has(a.key));
    if (newAlerts.length) {
      const lines = newAlerts.map(a => `${a.emoji} ${a.msg}`).join('\n');
      const msg = `🚨 <b>Onchain Signal 알림</b> [${now}]\n\n${lines}\n\n💰 BTC $${data.btcPrice?.toLocaleString() || '—'} (${data.btcChange?.toFixed(1) || '—'}%)\n😨 Fear&Greed: ${data.fg ?? '—'}`;
      await sendTelegram(msg);
      console.log(`[${now}] 알림 전송:`, newAlerts.map(a => a.key).join(', '));
    } else {
      console.log(`[${now}] 정상 — BTC $${data.btcPrice?.toLocaleString()} | F&G ${data.fg}`);
    }

    // 알림 키 업데이트 (1시간 후 재알림 허용)
    lastAlertKeys = new Set(alerts.map(a => a.key));
    setTimeout(() => { lastAlertKeys.clear(); }, 60 * 60 * 1000);

  } catch (e) {
    console.error(`[${now}] Error:`, e.message);
  }
}

// ── Start ──────────────────────────────────────────────────────
if (!TG_TOKEN || !TG_CHAT_ID) {
  console.warn('⚠️  TG_TOKEN 또는 TG_CHAT_ID 환경변수 없음. 알림 전송 비활성화.');
}

console.log(`✅ Onchain Signal Monitor 시작 — ${INTERVAL / 60000}분 간격`);
check();
setInterval(check, INTERVAL);

// Render.com keepalive (free tier sleep 방지)
if (process.env.RENDER) {
  const http = require('http');
  http.createServer((_, res) => { res.end('OK'); }).listen(process.env.PORT || 3000);
  console.log('🌐 Keepalive server listening');
}
