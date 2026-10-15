// Rasterize our original geometric SVG; no remote images, fonts or services.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const svg = fs.readFileSync(path.join(root, 'ui/logo.svg'), 'utf8');
    for (const size of [16, 48, 128, 256]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent('<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>' + svg);
      const file = path.join(root, `icons/icon${size}.png`);
      await page.screenshot({ path: file + '.tmp', type: 'png', omitBackground: true });
      fs.renameSync(file + '.tmp', file);
    }
    const png = fs.readFileSync(path.join(root,'icons/icon256.png'));
    const ico = Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4);
    ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12); ico.writeUInt32LE(png.length,14); ico.writeUInt32LE(22,18);
    fs.writeFileSync(path.join(root,'icons/icon.ico'), Buffer.concat([ico,png]));
    fs.writeFileSync(path.join(root,'icons/icon.svg.tmp'), svg);
    fs.renameSync(path.join(root,'icons/icon.svg.tmp'), path.join(root,'icons/icon.svg'));
    await page.setViewportSize({ width: 1280, height: 440 });
    await page.setContent('<style>body{margin:0}</style>'+fs.readFileSync(path.join(root,'docs/assets/cover.svg'),'utf8'));
    await page.screenshot({ path: path.join(root,'docs/assets/cover.png') });
    console.log('Generated original brand icons and repository cover.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
