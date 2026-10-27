import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function setWindowsGpuPreference(pref) {
  // pref: 0 = unset/default, 1 = Power Saving (Intel), 2 = High Performance (NVIDIA)
  try {
    if (pref === 0) {
      execSync(`powershell -NoProfile -Command "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -Name '${chromePath.replace(/\\/g, '\\\\')}' -ErrorAction SilentlyContinue"`);
    } else {
      execSync(`powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -Name '${chromePath.replace(/\\/g, '\\\\')}' -Value 'GpuPreference=${pref};' -Type String"`);
    }
  } catch (err) {
    console.warn('Registry set failed:', err.message);
  }
}

async function testGpuFlags(name, extraArgs) {
  const args = [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--hide-scrollbars',
    '--enable-gpu',
    ...extraArgs
  ];

  try {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args
    });

    const page = await browser.newPage();
    const info = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      if (!gl) return { error: 'No WebGL' };
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: gl.getParameter(debugInfo ? debugInfo.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
        renderer: gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
      };
    });

    await browser.close();
    console.log(`[${name}]:`, info.renderer);
    return info.renderer;
  } catch (err) {
    console.log(`[${name}] Error:`, err.message);
    return null;
  }
}

console.log('--- Testing ANGLE backends first ---');
await testGpuFlags('ANGLE Vulkan', ['--use-angle=vulkan']);
await testGpuFlags('ANGLE D3D11', ['--use-angle=d3d11']);
await testGpuFlags('ANGLE OpenGL', ['--use-angle=gl']);

console.log('\n--- Testing Windows DirectX UserGpuPreferences = 1 (Power Saving / Intel) ---');
setWindowsGpuPreference(1);
try {
  await testGpuFlags('Win Registry GpuPreference=1 (Default flags)', []);
  await testGpuFlags('Win Registry GpuPreference=1 + low-power', ['--gpu-preference=low-power']);
  await testGpuFlags('Win Registry GpuPreference=1 + Vulkan', ['--use-angle=vulkan']);
  await testGpuFlags('Win Registry GpuPreference=1 + D3D11', ['--use-angle=d3d11']);
} finally {
  console.log('Restoring registry...');
  setWindowsGpuPreference(0);
}

