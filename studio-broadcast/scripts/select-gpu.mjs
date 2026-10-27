#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serviceRoot } from '../src/config.mjs';

let chromePath = process.env.AIR3_CHROME_PATH || '';
if (!chromePath) {
  try {
    chromePath = readFileSync(resolve(serviceRoot, '.browser-path'), 'utf8').trim();
  } catch {
    chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
}

const target = (process.argv[2] || 'status').toLowerCase();

function queryStatus() {
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -Name '${chromePath.replace(/\\/g, '\\\\')}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty '${chromePath.replace(/\\/g, '\\\\')}'"`).toString().trim();
    if (out.includes('GpuPreference=1')) return 'Intel Arc / Power Saving (GpuPreference=1)';
    if (out.includes('GpuPreference=2')) return 'NVIDIA GeForce RTX 5090 / High Performance (GpuPreference=2)';
    return 'Default (System decides: NVIDIA RTX 5090)';
  } catch {
    return 'Default (System decides: NVIDIA RTX 5090)';
  }
}

switch (target) {
  case 'intel':
  case 'arc':
    execSync(`powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -Name '${chromePath.replace(/\\/g, '\\\\')}' -Value 'GpuPreference=1;' -Type String"`);
    console.log('✓ GPU switched to: Intel Arc Graphics (Power Saving)');
    break;
  case 'nvidia':
  case 'rtx':
    execSync(`powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -Name '${chromePath.replace(/\\/g, '\\\\')}' -Value 'GpuPreference=2;' -Type String"`);
    console.log('✓ GPU switched to: NVIDIA GeForce RTX 5090 (High Performance)');
    break;
  case 'reset':
  case 'default':
    execSync(`powershell -NoProfile -Command "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -Name '${chromePath.replace(/\\/g, '\\\\')}' -ErrorAction SilentlyContinue"`);
    console.log('✓ GPU preference reset to Windows default');
    break;
  case 'status':
  default:
    console.log(`Current Chromium GPU preference: ${queryStatus()}`);
    console.log('Usage: node scripts/select-gpu.mjs [intel|nvidia|reset|status]');
    break;
}
