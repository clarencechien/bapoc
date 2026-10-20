// Capture the twin in a headless browser: node tools/screenshot.mjs URL OUT.png [view] [hour] [w] [h] [xray]
import { chromium } from 'playwright';
const [url, out, view = 'overview', hour = '12', w = '1400', h = '860', xray = ''] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => document.getElementById('loading').hidden, null, { timeout: 120000 });
await page.evaluate(([v, hr, x]) => { twin.setTime(+hr * 4); twin.goView(v, true); if (x) twin.setXray(x === '1'); }, [view, hour, xray]);
await page.waitForTimeout(2500);
await page.screenshot({ path: out, timeout: 180000 });
console.log(JSON.stringify({ out, errors }));
await browser.close();
