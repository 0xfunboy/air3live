# Avvio completo #AIR3 Live Standalone 3.0 per PowerShell
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "  Avvio completo #AIR3 Live Standalone 3.0 (Regia + Studio 3D)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
node scripts/start-live.mjs $args
