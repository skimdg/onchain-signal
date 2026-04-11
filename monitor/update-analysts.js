/**
 * update-analysts.js — 애널리스트 포지션 자동 업데이트
 * GitHub Actions에서 매일 08:00 KST 실행
 * Claude API + web_search로 각 애널리스트 최신 포지션 조회 → analyst-data.json 저장
 *
 * ENV: CLAUDE_API_KEY (GitHub Secret)
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const ANALYSTS = [
  { id:'capriole',     name:'Charles Edwards', handle:'@caprioleio',      specialty:'해시 리본 · 온체인 정량 모델' },
  { id:'checkmate',    name:'Checkmate',        handle:'@_Checkmatey_',    specialty:'UTXO · 사이클 온체인 분석' },
  { id:'kiyoungju',    name:'Ki Young Ju',      handle:'@ki_young_ju',     specialty:'거래소 플로우 · 고래 추적' },
  { id:'willclemente', name:'Will Clemente',    handle:'@WClementeIII',    specialty:'기관 온체인 · 수요 분석' },
  { id:'bencowen',     name:'Ben Cowen',        handle:'@intocryptoverse', specialty:'수학 사이클 · 확률 기반 모델' },
  { id:'maartunn',     name:'Maartunn',          handle:'@JA_Maartun',      specialty:'OI · 레버리지 분석' },
  { id:'axeladler',    name:'Axel Adler Jr',    handle:'@AxelAdlerJr',     specialty:'거시 경제 + 온체인 통합' },
  { id:'cryptoviz',    name:'CryptoVizArt',     handle:'@CryptovizArt',    specialty:'알트코인 · 네트워크 지표' },
  { id:'skew',         name:'Skew',              handle:'@52kskew',         specialty:'파생상품 · OI 심층 분석' },
  { id:'carpenoctom',  name:'CarpeNoctom',       handle:'@CarpeNoctom',     specialty:'포지션 트레이딩 · 거시 전략' },
];

// ── 기존 데이터 로드 (실패 시 하드코딩 기본값 사용) ──
const OUTPUT_PATH = path.join(__dirname, '..', 'analyst-data.json');
let prevData = {};
try {
  const raw = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  prevData = Object.fromEntries((raw.analysts || []).map(a => [a.id, a]));
} catch { /* 첫 실행 */ }

async function scanOne(analyst) {
  console.log(`\n🔍 스캔: ${analyst.name} (${analyst.handle})`);
  const prompt = `${analyst.name} (Twitter: ${analyst.handle})의 최근 비트코인 시장 입장을 웹 검색으로 찾아 분석해줘.
최근 트윗·유튜브·뉴스레터 기준. 전문 분야: ${analyst.specialty}
JSON만 응답(마크다운 없이):
{"position":"bull"|"bear"|"neutral","bullPct":0~100,"summary":"현재 관점 한국어 60자 이내"}
못 찾으면 summary에 "(추정)" 표시.`;

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    const txt = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const match = txt.match(/\{[^{}]*\}/);
    if (!match) throw new Error('JSON 파싱 실패: ' + txt.substring(0, 100));

    const parsed = JSON.parse(match[0]);
    const bullPct = Math.max(0, Math.min(100, parseInt(parsed.bullPct) ?? 50));
    const stance  = bullPct >= 60 ? '강세' : bullPct >= 40 ? '중립' : '약세';

    console.log(`  ✅ ${analyst.name}: ${stance} (${bullPct}%) — ${parsed.summary}`);
    return {
      id:        analyst.id,
      bullPct,
      summary:   (parsed.summary || '').substring(0, 80),
      lastScan:  new Date().toLocaleDateString('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit' })
                   .replace(/\.\s*/g, '.').replace(/\.$/, ''),
      scanning:  false,
    };
  } catch (e) {
    console.error(`  ❌ ${analyst.name} 실패: ${e.message}`);
    // 실패 시 이전 데이터 유지
    const prev = prevData[analyst.id];
    if (prev) { console.log(`  ↩️ 이전 데이터 유지: ${prev.bullPct}%`); return { ...prev, scanning: false }; }
    return null;
  }
}

async function main() {
  if (!process.env.CLAUDE_API_KEY) {
    console.error('❌ CLAUDE_API_KEY 환경변수가 없습니다.');
    process.exit(1);
  }

  console.log('🚀 애널리스트 포지션 자동 업데이트 시작');
  console.log(`   대상: ${ANALYSTS.length}명\n`);

  const results = [];
  for (const analyst of ANALYSTS) {
    const result = await scanOne(analyst);
    if (result) results.push(result);
    await new Promise(r => setTimeout(r, 2500)); // API rate limit 방지
  }

  if (results.length === 0) {
    console.error('❌ 모든 스캔 실패');
    process.exit(1);
  }

  const avgBull = Math.round(results.reduce((s, a) => s + a.bullPct, 0) / results.length);
  const output = {
    analysts:      results,
    avgBull,
    updatedAt:     new Date().toISOString(),
    updatedAtKST:  new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✅ 완료: ${results.length}/${ANALYSTS.length}명 업데이트`);
  console.log(`   평균 강세%: ${avgBull}%`);
  console.log(`   저장: analyst-data.json`);
  process.exit(0);
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
