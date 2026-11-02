// Read-only visual comparison. Does not connect a player or send producer data.
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../studio-broadcast/package.json',import.meta.url));
const puppeteer=require('puppeteer-core');
const executablePath=(await fs.readFile('/home/funboy/air3live/studio-broadcast/.browser-path','utf8')).trim();
const directory=join(homedir(),'.local/state/air3live-v2-preview',`visual-${Date.now()}`);
await fs.mkdir(directory,{recursive:true,mode:0o700});
const browser=await puppeteer.launch({executablePath,headless:'new',defaultViewport:{width:1280,height:720},
  env:{PATH:process.env.PATH,HOME:homedir(),LANG:'en_US.UTF-8',XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,
    LD_LIBRARY_PATH:'/home/funboy/.local/lib/nvidia/usr/lib/x86_64-linux-gnu:/home/funboy/.local/usr/lib/x86_64-linux-gnu',
    VK_ICD_FILENAMES:'/home/funboy/.local/share/vulkan/icd.d/nvidia_icd.json',
    __EGL_VENDOR_LIBRARY_FILENAMES:'/home/funboy/.local/lib/nvidia/usr/share/glvnd/egl_vendor.d/10_nvidia.json'},
  args:['--no-sandbox','--enable-gpu','--ignore-gpu-blocklist','--use-gl=angle','--use-angle=gl-egl']});
try{
  for(const [name,port] of [['v2',5891],['v1',5890]]){
    const page=await browser.newPage();const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,500));});
    await page.goto(`http://127.0.0.1:${port}/studio?output=1`,{waitUntil:'load'});
    await page.waitForFunction(()=>!!window.air3Studio?.ready);await page.evaluate(()=>window.air3Studio.ready);
    const frame=await page.evaluate(()=>window.air3Studio.captureFrame());
    await fs.writeFile(join(directory,`${name}-scene.png`),Buffer.from(frame.split(',')[1],'base64'),{mode:0o600});
    await page.screenshot({path:join(directory,`${name}-program.png`)});
    const result=await page.evaluate(()=>{const d=window.air3Studio.diagnostics();return{gpu:d.gpuRenderer,fps:d.fps,triangles:d.triangles,drawCalls:d.drawCalls,contextLost:d.contextLost};});
    console.log(JSON.stringify({name,directory,result,errors}));await page.close();
  }
}finally{await browser.close();}
