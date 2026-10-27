@echo off
setlocal
cd /d "%~dp0"
echo Apertura cartella registrazioni in Esplora Risorse...
start "" "%~dp0studio-broadcast\data\recordings"
