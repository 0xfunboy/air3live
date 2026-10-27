@echo off
setlocal
cd /d "%~dp0"
echo ========================================================================
echo   Avvio #AIR3 Live Standalone 3.0 su GPU Intel Arc (Regia + Studio 3D)
echo ========================================================================
node scripts\start-live.mjs intel
set "AIR3_EXIT=%errorlevel%"
if not "%AIR3_EXIT%"=="0" pause
exit /b %AIR3_EXIT%
