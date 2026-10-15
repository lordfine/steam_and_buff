// Real MV3 browser, fresh profile, synthetic market replies. No account required.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = require('../manifest.json').version;
const extension = path.join(root, 'dist/extension/steam_and_buff-' + version);
const fixture = require('./fixtures/steam-market-pages.json');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skinledger-extension-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 1440, height: 1080 } });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const mockSource = require('../desktop/demo').demoFetch.toString();
    await worker.evaluate(({ source, fixture }) => {
      const mock = (0, eval)('(' + source + ')');
      const nativeFetch = fetch;
      globalThis.realMarketFetch = nativeFetch;
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('/market/listings/')) {
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          return new Response(rules.length ? fixture.legacy : `<script id="valve-ssr-data">${JSON.stringify(fixture.ssr)}</script>`);
        }
        return mock(url, opts);
      };
      // Keep production request ordering while avoiding intentional five-second waits.
      sleep = async () => {};
    }, { source: mockSource, fixture });
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page).toHaveTitle('steam_and_buff·倒余额');
  await expect(page.locator('body')).not.toContainText('SkinLedger');
  await expect(page.locator('body')).not.toContainText('MARKET INTELLIGENCE');
  await expect(page.locator('body')).not.toContainText('ITEM INSIGHT');
    await page.locator('#btnStartScan').click();
    await expect(page.locator('#quoteSummary')).toContainText('已复核 2', { timeout: 20000 });
    await expect(page.locator('#itemList .item-card')).toHaveCount(2);
    await expect(page.locator('#quoteSummary')).toContainText('失败 0');
    await expect(page.locator('#btnStartScan')).toBeEnabled();
    await expect(page.locator('#btnStopScan')).toBeDisabled();
    const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0].condition.initiatorDomains, [id]);
    assert.deepEqual(rules[0].action.requestHeaders, [{ header: 'cookie', operation: 'append', value: 'bMarketOptOut=1' }]);
    assert.equal((await context.cookies()).length, 0, 'No browser cookie jar changes');
    await page.locator('#btnNeedsReview').click();
    await expect(page.locator('#itemList .item-card')).toHaveCount(3);
    await page.locator('#maxPriceFilter').fill('0');
    await expect(page.locator('#itemList .item-card')).toHaveCount(0);
    await page.locator('#btnNeedsReview').click();
    fs.mkdirSync(path.join(root, 'docs/assets'), { recursive: true });
    await page.locator('body').screenshot({ path: path.join(root, 'docs/assets/extension-popup.png') });
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    await expect(page.locator('#tableBody tr')).toHaveCount(2);
    await expect(page.locator('#quoteSummary')).toContainText('已复核 2');
    await page.screenshot({ path: path.join(root, 'docs/assets/extension.png'), fullPage: true });
    // A stale quote with an existing orderbook must still be eligible for refresh.
    await worker.evaluate(() => { liveItems[0].steamVerifiedAt = Date.now() - 31 * 60000; liveItems[1].steamEnrichError = '测试失败：HTTP 429'; });
    await page.locator('#btnRefresh').click();
    await expect(page.locator('#quoteSummary')).toContainText('已过期 1');
    await expect(page.locator('#quoteFailureNotice')).toContainText('HTTP 429');
    await page.locator('#btnNeedsReview').click();
    await page.locator('#btnEnrichSteam').click();
    await expect(page.locator('#quoteSummary')).toContainText('已复核 3', { timeout: 20000 });
    await expect(page.locator('#quoteFailureNotice')).toBeHidden();
    assert.deepEqual(errors, []);
    console.log('PASS: real MV3 popup/dashboard, shared Steam fallback, scoped DNR rule, stale retry, missing/zero filters and diagnostics');
    // Explicit opt-in read-only public request: no real profile, account or auth cookies.
    if (process.env.SKINLEDGER_LIVE_TEST === '1') {
      const result = await worker.evaluate(async () => {
        globalThis.fetch = globalThis.realMarketFetch;
        const response = await fetchMarket('https://steamcommunity.com/market/listings/570/Feast%20of%20Abscession%20-%20Back', { steamMarketLegacy: true });
        return { status: response.status, source: parseSteamMarketPage(await response.text(), 570, 'Feast of Abscession - Back') };
      });
      assert.equal(result.status, 200);
      assert.equal(result.source.kind, 'legacy');
      console.log('PASS: actual Steam listing fetched in isolated Chromium with extension-scoped legacy preference');
    }
  } finally {
    await context?.close();
    const resolved = path.resolve(profile);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('skinledger-extension-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
