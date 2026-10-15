const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
let profile;
let profileRoot;
let desktop;
let page;
let errors;

async function launch(demoMode = true) {
  const env = { ...process.env, STEAM_BALANCE_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.STEAM_BALANCE_TEST_EXE;
  desktop = await electron.launch({
    ...(executablePath ? { executablePath, args: demoMode ? ['--demo'] : [] } : { args: [root, ...(demoMode ? ['--demo'] : [])] }), env
  });
  page = await desktop.firstWindow();
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('#modeBadge')).toContainText(demoMode ? '离线演示' : '独立桌面应用');
}
async function scan() {
  await page.getByRole('button', { name: '扫描并筛选', exact: true }).click();
  await expect(page.locator('#scanStatus')).toContainText('扫描完成');
  await expect(page.locator('#ovTotal')).toHaveText('3');
  await expect(page.locator('#tableBody tr')).toHaveCount(2);
}
test.beforeEach(async () => {
  profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-balance-e2e-'));
  profile = path.join(profileRoot, 'fresh-profile'); // Must also work on first install.
  await launch();
});
test.afterEach(async () => {
  if (desktop) await desktop.close();
  // Delete only this test's own, absolute OS-temporary profile directory.
  fs.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('native window, empty state, sandbox boundary and offline session check', async () => {
  await expect(page).toHaveTitle('SkinLedger · 饰账｜本地版');
  await expect(page.locator('#demoNotice')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录 BUFF', exact: true })).toBeDisabled();
  await expect(page.locator('#ovTotal')).toHaveText('0');
  expect(await page.evaluate(() => ({ require: typeof require, node: typeof process, bridge: typeof window.desktop.request })))
    .toEqual({ require: 'undefined', node: 'undefined', bridge: 'function' });
  await page.getByRole('button', { name: '检查登录', exact: true }).click();
  await expect(page.locator('#sessionStatus')).toContainText('无真实账号');
  const blocked = await page.evaluate(() => window.desktop.openExternal('file:///C:/Windows/System32/cmd.exe'));
  expect(blocked.ok).toBe(false);
  expect(errors).toEqual([]);
});

test('scan, shortlist, exact search, filters, extra verification and no renderer errors', async () => {
  await scan();
  await expect(page.locator('#ovAvgRatio')).toHaveText('2');
  await page.getByRole('searchbox').fill('Demo Item 2');
  await expect(page.locator('#tableBody tr')).toHaveCount(1);
  await expect(page.locator('#tableBody')).toContainText('蓝色');
  await page.getByRole('searchbox').fill('');
  await page.locator('#ratioFilter').fill('0.65');
  await expect(page.locator('#tableBody tr')).toHaveCount(1);
  await page.locator('#ratioFilter').fill('2');
  await page.locator('#candidateFilter').uncheck();
  await expect(page.locator('#tableBody tr')).toHaveCount(3);
  await page.getByRole('button', { name: '复核 Steam 行情', exact: true }).click();
  await expect(page.locator('#tableBody')).not.toContainText('未核实');
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/desktop-preview.png', fullPage: true });
});

test('invalid page gives validation message without starting a task', async () => {
  await page.locator('#buffPage').fill('0');
  await page.getByRole('button', { name: '扫描并筛选', exact: true }).click();
  await expect(page.locator('#feedback')).toContainText('页码必须');
  await expect(page.getByRole('button', { name: '扫描并筛选', exact: true })).toBeEnabled();
  await expect(page.locator('#ovTotal')).toHaveText('0');
});

test('reload and process restart restore disk results and filter settings', async () => {
  await scan();
  await page.locator('#ratioFilter').fill('0.65');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'data.json'), 'utf8')).dashboardFilters?.ratioFilter).toBe('0.65');
  await page.keyboard.press('Control+r');
  await expect(page.locator('#ratioFilter')).toHaveValue('0.65');
  await expect(page.locator('#ovTotal')).toHaveText('3');
  await desktop.close(); desktop = null;
  await launch();
  await expect(page.locator('#ratioFilter')).toHaveValue('0.65');
  await expect(page.locator('#ovTotal')).toHaveText('3');
  await expect(page.locator('#tableBody tr')).toHaveCount(1);
});

test('native CSV and JSON export writes selected rows and preserves existing file', async () => {
  await scan();
  for (const type of ['csv', 'json']) {
    const target = path.join(profile, `export.${type}`);
    fs.writeFileSync(target, 'previous export');
    // Stub only the OS save dialog. The real preload, IPC, validation, and disk write run.
    await desktop.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);
    await page.getByRole('button', { name: `导出 ${type.toUpperCase()}`, exact: true }).click();
    await expect(page.locator('#feedback')).toContainText(target);
    const contents = fs.readFileSync(target, 'utf8');
    if (type === 'json') expect(JSON.parse(contents)).toHaveLength(2);
    else { expect(contents.charCodeAt(0)).toBe(0xfeff); expect(contents).toContain('快速成本率'); expect(contents.split('\n')).toHaveLength(3); }
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe('previous export');
  }
  expect(errors).toEqual([]);
});

test('normal mode uses an isolated sandboxed login window sharing the market session', async () => {
  await desktop.close(); desktop = null;
  await launch(false);
  await expect(page.locator('#demoNotice')).toBeHidden();
  // Handle HTTPS in-process for this test: no third-party login or network requests.
  await desktop.evaluate(async ({ session }) => {
    const market = session.fromPartition('persist:market');
    await market.cookies.set({ url: 'https://buff.163.com', name: 'desktop-test-session', value: 'fixture', secure: true, expirationDate: Date.now() / 1000 + 86400 });
    market.protocol.handle('https', request => {
      if (new URL(request.url).pathname.includes('/api/market/goods')) {
        return new Response(JSON.stringify({ code: 'OK' }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('<!doctype html><html><title>BUFF test login</title><h1>Test login fixture</h1></html>', { headers: { 'Content-Type': 'text/html' } });
    });
  });
  await page.getByRole('button', { name: '登录 BUFF', exact: true }).click();
  await expect.poll(() => desktop.windows().length).toBe(2);
  const login = desktop.windows().find(window => window !== page);
  await expect(login).toHaveTitle('BUFF test login');
  expect(await login.evaluate(() => [typeof require, typeof process, typeof window.desktop])).toEqual(['undefined', 'undefined', 'undefined']);
  expect(await desktop.evaluate(({ BrowserWindow, session }) => {
    const windows = BrowserWindow.getAllWindows();
    const login = windows.find(window => window.webContents.getURL().startsWith('https:'));
    return login.webContents.session === session.fromPartition('persist:market');
  })).toBe(true);
  await page.getByRole('button', { name: '检查登录', exact: true }).click();
  await expect(page.locator('#sessionStatus')).toHaveText('BUFF 会话可用');
  expect(errors).toEqual([]);
  const closed = desktop.waitForEvent('close');
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')).close();
  });
  await closed;
  desktop = null;
  await launch(false);
  expect(await desktop.evaluate(async ({ session }) => {
    const cookies = await session.fromPartition('persist:market').cookies.get({ name: 'desktop-test-session' });
    return cookies[0]?.value;
  })).toBe('fixture');
});

test('favorites persist, detail explains evidence and allows refreshing an already verified item', async () => {
  await scan();
  await page.getByRole('button', { name: '收藏 演示 · 赤红饰品', exact: true }).click();
  await expect(page.locator('#favoriteCount')).toHaveText('1');
  await page.locator('#favoritesOnly').check();
  await expect(page.locator('#tableBody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '演示 · 赤红饰品', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '演示 · 赤红饰品' })).toBeVisible();
  await expect(page.locator('#detailMetrics')).toContainText('¥100.00');
  await expect(page.locator('#detailEvidence')).toContainText('达标候选');
  const before = await page.evaluate(async () => (await window.desktop.request({ action: 'getLiveItems' })).items[0].steamAttemptedAt);
  await page.getByRole('button', { name: '重新复核此物品', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.desktop.request({ action: 'getLiveItems' })).items[0].steamAttemptedAt)).toBeGreaterThan(before);
  await expect(page.locator('#btnDetailRefresh')).toBeEnabled();
  await expect(page.locator('#detailEvidence')).toContainText('达标候选');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await desktop.close(); desktop = null;
  await launch();
  await expect(page.locator('#favoritesOnly')).toBeChecked();
  await expect(page.locator('#tableBody tr')).toHaveCount(1);
  await expect(page.locator('#favoriteCount')).toHaveText('1');
  await page.getByRole('button', { name: '取消收藏 演示 · 赤红饰品', exact: true }).click();
  await expect(page.locator('#tableBody')).toContainText('没有符合筛选的收藏');
  const invalid = await page.evaluate(() => window.desktop.setFavorite('../../file', true));
  expect(invalid.ok).toBe(false);
  expect(errors).toEqual([]);
});

test('history archives old results, restores across games and survives process restart', async () => {
  await scan();
  await page.locator('#gameSelect').selectOption('dota2');
  await scan();
  await expect(page.locator('#tableBody')).toContainText('DOTA2');
  await desktop.close(); desktop = null;
  await launch();
  await page.getByRole('button', { name: '扫描历史', exact: true }).click();
  await expect(page.locator('#historyList')).toContainText('CS2 · 3 件');
  await page.getByRole('button', { name: '恢复此记录', exact: true }).first().click();
  await expect(page.locator('#historyDialog')).not.toBeVisible();
  await expect(page.locator('#scanStatus')).toContainText('已恢复历史结果');
  await expect(page.locator('#tableBody')).toContainText('CS2');
  await expect(page.locator('#tableBody')).not.toContainText('DOTA2');
  await page.getByRole('button', { name: '扫描历史', exact: true }).click();
  await expect(page.locator('#historyList')).toContainText('DOTA2 · 3 件');
  expect(errors).toEqual([]);
});

test('zero price, invalid range, reset and pending view behave consistently', async () => {
  await scan();
  await page.locator('#maxPrice').fill('0');
  await expect(page.locator('#resultCount')).toContainText('0 件');
  await expect(page.locator('#btnExportCSV')).toBeDisabled();
  await page.locator('#minPrice').fill('1');
  await expect(page.locator('#filterMessage')).toContainText('最低价不能大于最高价');
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await expect(page.locator('#tableBody tr')).toHaveCount(2);
  await expect(page.locator('#filterMessage')).toBeHidden();
  await page.getByRole('button', { name: '查看待处理', exact: true }).click();
  await expect(page.locator('#tableBody tr')).toHaveCount(1);
  await expect(page.locator('#tableBody')).toContainText('稀有饰品');
  await page.getByRole('button', { name: '复核 Steam 行情', exact: true }).click();
  await expect(page.locator('#quoteSummary')).toContainText('已复核 3');
  await expect(page.locator('#resultCount')).toContainText('0 件');
  expect(errors).toEqual([]);
});

test('expired two-sided quotes cannot pass candidates or be freshened by Steam-only refresh', async () => {
  await scan();
  await desktop.close(); desktop = null;
  const dataFile = path.join(profile, 'data.json');
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  for (const item of data.scanResult_chunk_0) item.buffFetchedAt = Date.now() - 31 * 60000;
  fs.writeFileSync(dataFile, JSON.stringify(data));
  await launch();
  await expect(page.locator('#ovAvgRatio')).toHaveText('0');
  await expect(page.locator('#ovBestRatio')).toHaveText('—');
  await expect(page.locator('#quoteSummary')).toContainText('已过期 2');
  await page.getByRole('button', { name: '查看待处理', exact: true }).click();
  await page.getByRole('button', { name: '演示 · 赤红饰品', exact: true }).click();
  await expect(page.locator('#detailEvidence')).toContainText('请重新扫描');
  await page.getByRole('button', { name: '重新复核此物品', exact: true }).click();
  await expect(page.locator('#btnDetailRefresh')).toBeEnabled();
  await expect(page.locator('#detailEvidence')).toContainText('行情过期');
  await expect(page.locator('#ovAvgRatio')).toHaveText('0');
  await page.screenshot({ path: 'test-results/quote-details.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('descending sort keeps unknowns last and refresh preserves the current page', async () => {
  await scan();
  await desktop.close(); desktop = null;
  const dataFile = path.join(profile, 'data.json');
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const base = data.scanResult_chunk_0[0];
  data.scanResult_chunk_0 = Array.from({ length: 205 }, (_, i) => ({ ...base, id: 800000 + i, name: `分页测试 ${i}`, shortName: `分页测试 ${i}` }));
  data.scanResult_chunk_0[0].quickSellCostRate = null;
  data.scanResult.totalItems = 205;
  data.scanResult.stats.scannedItems = 205;
  await fs.promises.writeFile(dataFile, JSON.stringify(data));
  await launch();
  await page.locator('#candidateFilter').uncheck();
  await page.locator('#sortBy').selectOption('quickSellCostRate');
  await page.locator('#sortOrder').selectOption('desc');
  await expect(page.locator('#tableBody tr').first()).not.toContainText('分页测试 0');
  await page.locator('#pagination').getByRole('button', { name: '3', exact: true }).click();
  await expect(page.locator('#tableBody tr')).toHaveCount(5);
  await expect(page.locator('#tableBody tr').last()).toContainText('分页测试 0');
  await page.getByRole('button', { name: '重读本地数据', exact: true }).click();
  await expect(page.locator('#pagination button.active')).toHaveText('3');
  await expect(page.locator('#tableBody tr')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('a failed review is visible even when candidate filtering leaves the table empty', async () => {
  await scan();
  await desktop.close(); desktop = null;
  const file = path.join(profile, 'data.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const item of data.scanResult_chunk_0) item.steamVerifiedAt = null;
  Object.assign(data.scanResult_chunk_0[0], { steamOrderbookAvailable: false, steamEnrichError: 'Steam 求购盘读取失败：测试 HTTP 429' });
  fs.writeFileSync(file, JSON.stringify(data));
  await launch();
  await expect(page.locator('#resultCount')).toContainText('0 件');
  await expect(page.locator('#quoteFailureNotice')).toContainText('测试 HTTP 429');
  await page.getByRole('button', { name: '查看失败详情', exact: true }).click();
  await expect(page.locator('#tableBody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '演示 · 赤红饰品', exact: true }).click();
  await expect(page.locator('#detailEvidence')).toContainText('测试 HTTP 429');
  await page.getByRole('button', { name: '重新复核此物品', exact: true }).click();
  await expect(page.locator('#btnDetailRefresh')).toBeEnabled();
  await expect(page.locator('#detailEvidence')).toContainText('达标候选');
  await expect(page.locator('#quoteFailureNotice')).toBeHidden();
  expect(errors).toEqual([]);
});
