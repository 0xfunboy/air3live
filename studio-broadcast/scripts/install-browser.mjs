import { install, Browser } from '@puppeteer/browsers';
import { PUPPETEER_REVISIONS } from 'puppeteer-core';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serviceRoot } from '../src/config.mjs';
const result = await install({ browser: Browser.CHROME, buildId: PUPPETEER_REVISIONS.chrome, cacheDir: resolve(serviceRoot, '.cache/browser') });
await writeFile(resolve(serviceRoot, '.browser-path'), result.executablePath + '\n');
console.log(JSON.stringify({ browser: 'Chrome for Testing', buildId: PUPPETEER_REVISIONS.chrome, executablePath: result.executablePath }));
