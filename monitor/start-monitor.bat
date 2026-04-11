@echo off
REM ── Onchain Signal 로컬 모니터 실행 ──
REM 이 파일을 Windows 시작프로그램에 등록하면 PC 켤 때 자동 실행됩니다.
REM
REM 환경변수 설정 (본인 값으로 변경):
set TG_TOKEN=여기에_봇토큰_입력
set TG_CHAT_ID=여기에_채팅ID_입력
set INTERVAL_MIN=5

cd /d "%~dp0"
echo [%date% %time%] Onchain Signal Monitor 시작...
node monitor.js >> monitor.log 2>&1
