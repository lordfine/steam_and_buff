// The NSIS portable wrapper does not forward the inspector pipes expected by
// Playwright's _electron.launch. Connect to its loopback-only CDP port instead.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-balance-portable-'));
  const profile = path.join(directory, 'fresh-profile');
  const executable = path.resolve(__dirname, `../dist/desktop/SkinLedger-${require('../package.json').version}-x64.exe`);
  const env = { ...process.env, STEAM_BALANCE_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--demo', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: 'ignore' });
  let browser;
  let exited = false;
  let launchError;
  child.on('error', error => { launchError = error; });
  const exit = once(child, 'exit').then(() => { exited = true; });
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(portFile)) {
      if (launchError) throw launchError;
      if (exited || Date.now() > deadline) throw new Error('Portable app did not become ready');
      await pause(100);
    }
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    if (!Number.isSafeInteger(port) || port < 1) throw new Error('Invalid debugger port');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0];
    await expect(page.locator('#modeBadge')).toContainText('离线演示');
    await page.getByRole('button', { name: '扫描并筛选', exact: true }).click();
    await expect(page.locator('#scanStatus')).toContainText('扫描完成');
    await expect(page.locator('#ovTotal')).toHaveText('3');
    await expect(page.locator('#tableBody tr')).toHaveCount(2);
    console.log('PASS: single-file portable EXE starts with a fresh profile and completes offline scan/filter');
    await page.evaluate(() => window.close());
    await Promise.race([exit, pause(10000).then(() => { if (!exited) throw new Error('Portable app did not exit'); })]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!exited) child.kill();
    await exit.catch(() => {});
    // Only the absolute, uniquely created OS temp directory from this run.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
