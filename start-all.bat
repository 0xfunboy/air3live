@echo off
setlocal
cd /d "%~dp0"
echo ========================================================================
echo   Avvio completo #AIR3 Live Standalone 3.0 (Regia + Studio 3D)
echo ========================================================================
node scripts\start-live.mjs %*
set "AIR3_EXIT=%errorlevel%"
if not "%AIR3_EXIT%"=="0" pause
exit /b %AIR3_EXIT%
