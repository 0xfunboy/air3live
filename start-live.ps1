# Avvio #AIR3 Live Standalone 3.0 (Regia + Studio 3D) per PowerShell
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "  Avvio #AIR3 Live Standalone 3.0 (Regia + Studio 3D)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
node scripts/start-live.mjs $args
