const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { createStore } = require('../desktop/store');
const { createEngine } = require('../desktop/engine');
const { demoFetch } = require('../desktop/demo');
const { isMarketUrl, isLoginUrl, createMarketFetch } = require('../desktop/security');

function storeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-balance-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createStore(directory) };
}
function engineFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-balance-unit-'));
  const fixture = { directory, store: createStore(directory) };
  const engine = createEngine({ store: fixture.store, fetch: demoFetch, wait: () => Promise.resolve(), ...options });
  t.after(async () => { await engine.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...fixture, engine };
}
async function until(engine, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await engine.request({ action: 'getLiveItems' });
    if (predicate(state)) return state;
    await pause(10);
  }
  throw new Error('engine state deadline exceeded');
}
const finished = state => !state.isScanning && !state.isEnriching && state.scanState;

test('disk store serializes parallel writes, clones values and persists across restart', async t => {
  const { store, directory } = storeFixture(t);
  const values = { preferences: { ratio: 0.75 } };
  const first = store.set(values);
  values.preferences.ratio = 9;
  await Promise.all([first, store.set({ second: 2 }), store.set({ third: 3 })]);
  const reloaded = createStore(directory);
  assert.deepEqual(reloaded.get(null), { preferences: { ratio: 0.75 }, second: 2, third: 3 });
  const copy = reloaded.get('preferences');
  copy.preferences.ratio = 5;
  assert.equal(reloaded.get('preferences').preferences.ratio, 0.75);
  await store.remove('second');
  assert.equal(store.get('second').second, undefined);
});

test('store recovers an atomic backup and preserves corrupt bytes', async t => {
  const { store, directory } = storeFixture(t);
  await store.set({ valid: 1 });
  await store.set({ valid: 2 });
  fs.writeFileSync(store.file, '{broken');
  assert.equal(createStore(directory).get('valid').valid, 1);
  assert.ok(fs.readdirSync(directory).some(file => file.includes('.corrupt-')));
});

test('store marks previous process running scan as interrupted', async t => {
  const { store, directory } = storeFixture(t);
  await store.set({ scanState: { status: 'running', scannedItems: 40 } });
  assert.equal(createStore(directory).get('scanState').scanState.status, 'aborted');
});

test('desktop boundary rejects arbitrary actions, invalid game/page and huge enrichment batch', async t => {
  const { engine } = engineFixture(t);
  for (const message of [null, { action: 'eval' }, { action: 'startScan', game: 'unknown', scanMode: 'all' },
    { action: 'startScan', game: 'csgo', scanMode: 'current_page', page: 0 },
    { action: 'enrichSteam', itemIds: new Array(21).fill(1) }]) {
    assert.equal((await engine.request(message)).ok, false);
  }
});

test('desktop scan uses explicit page, verifies conservative price and persists complete result', async t => {
  const requests = [];
  const { engine, directory } = engineFixture(t, { fetch: (url, options) => { requests.push(String(url)); return demoFetch(url, options); } });
  assert.equal((await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'current_page', page: 7 })).ok, true);
  const state = await until(engine, finished);
  assert.equal(state.scanState.status, 'completed');
  assert.equal(state.items.length, 3);
  assert.equal(state.items[0].quickSellCostRate, 0.6);
  assert.equal(state.items[0].liquidityDays, 1.5);
  assert.equal(state.items[2].steamOrderbookAvailable, false); // outside shortlist, not silently verified
  assert.match(requests[0], /page_num=7/);
  assert.equal(createStore(directory).get('scanResult').scanResult.totalItems, 3);
});

test('genuine auth failure stays actionable without reading or exporting cookies', async t => {
  const { engine } = engineFixture(t, { fetch: async () => Response.json({ code: 'Login Required' }) });
  await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'all' });
  const state = await until(engine, finished);
  assert.equal(state.scanState.status, 'error');
  assert.match(state.scanState.error, /BUFF.*未授权.*登录/);
});

test('unavailable order book never fabricates a quick-sale candidate', async t => {
  const { engine } = engineFixture(t, { fetch: (url, options) => String(url).includes('/market/listings/')
    ? Promise.resolve(new Response('<html>SPA without item_nameid</html>')) : demoFetch(url, options) });
  await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'current_page' });
  const state = await until(engine, finished);
  assert.equal(state.items[0].steamOrderbookAvailable, false);
  assert.equal(state.items[0].quickSellCostRate, null);
  assert.equal(state.stats.profitableItems, 0);
});

test('cancel during multi-page wait preserves partial results and allows another scan', async t => {
  const { engine } = engineFixture(t, { wait: undefined, fetch: async (url, options) => {
    if (String(url).includes('buff.163.com')) {
      const data = await (await demoFetch(url, options)).json();
      data.data.total_count = 160;
      return Response.json(data);
    }
    return demoFetch(url, options);
  } });
  await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'all' });
  await until(engine, state => state.items.length === 3);
  assert.equal((await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'all' })).ok, false);
  await engine.request({ action: 'stopScan' });
  const state = await until(engine, finished);
  assert.equal(state.scanState.status, 'cancelled');
  assert.equal((await engine.request({ action: 'getScanResult' })).result.items.length, 3);
  assert.equal((await engine.request({ action: 'startScan', game: 'dota2', scanMode: 'current_page' })).ok, true);
  await engine.close();
});

test('network and external-link allowlists block local files, lookalike domains and credentials', () => {
  for (const value of ['file:///etc/passwd', 'http://buff.163.com', 'https://buff.163.com.attacker.test', 'https://steamcommunity.com@evil.test', 'https://buff.163.com:5000', 'javascript:alert(1)']) {
    assert.equal(isMarketUrl(value), false, value);
    assert.equal(isLoginUrl(value), false, value);
  }
  assert.equal(isMarketUrl('https://buff.163.com/goods/123'), true);
  assert.equal(isLoginUrl('https://login.steampowered.com/openid/login'), true);
});

test('market fetch uses the login session, bounded timeout, includes credentials and forbids redirects', async () => {
  let received;
  const marketFetch = createMarketFetch({ fetch: async (url, options) => { received = { url, options }; return Response.json({ code: 'OK' }); } });
  await marketFetch('https://buff.163.com/api/market/goods');
  assert.equal(received.options.credentials, 'include');
  assert.equal(received.options.redirect, 'error');
  assert.ok(received.options.signal instanceof AbortSignal);
  assert.throws(() => marketFetch('file:///secret'));
});

test('failed forced refresh invalidates previously confirmed quick-sale quote', async t => {
  let fail = false;
  const { engine } = engineFixture(t, { fetch: (url, options) => fail && String(url).includes('itemordershistogram')
    ? Promise.resolve(new Response('unavailable', { status: 403 })) : demoFetch(url, options) });
  await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'current_page' });
  let state = await until(engine, finished);
  assert.equal(state.items[0].steamOrderbookAvailable, true);
  fail = true;
  await engine.request({ action: 'enrichSteam', itemIds: [900001], force: true });
  state = await until(engine, finished);
  assert.equal(state.items[0].steamOrderbookAvailable, false);
  assert.equal(state.items[0].quickSellCostRate, null);
  assert.equal(state.items[0].steamVerifiedAt, null);
  assert.match(state.items[0].steamEnrichError, /403/);
});

test('partial volume failure never combines new orderbook with old liquidity', async t => {
  let fail = false;
  const { engine } = engineFixture(t, { fetch: (url, options) => fail && String(url).includes('priceoverview')
    ? Promise.resolve(Response.json({ success: false })) : demoFetch(url, options) });
  await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'current_page' });
  await until(engine, finished);
  fail = true;
  await engine.request({ action: 'enrichSteam', itemIds: [900001], force: true });
  const state = await until(engine, finished);
  assert.equal(state.items[0].steamVerifiedAt, null);
  assert.equal(state.items[0].liquidityDays, null);
  assert.ok(state.items[0].steamEnrichError);
});

test('a failed empty scan preserves last result, and history restores snapshots after restart', async t => {
  let fail = false;
  const { engine, directory } = engineFixture(t, { fetch: (url, options) => fail
    ? Promise.resolve(Response.json({ code: 'Login Required' })) : demoFetch(url, options) });
  await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'current_page' });
  await until(engine, finished);
  fail = true;
  await engine.request({ action: 'startScan', game: 'dota2', scanMode: 'current_page' });
  await until(engine, state => !state.isScanning && state.scanState?.status === 'error');
  assert.equal((await engine.request({ action: 'getScanResult' })).result.items.length, 3);
  const history = await engine.request({ action: 'listHistory' });
  assert.equal(history.ok, true);
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].game, 'csgo');
  await engine.close();
  const restored = createEngine({ store: createStore(directory), fetch: demoFetch, wait: () => Promise.resolve() });
  try {
    assert.equal((await restored.request({ action: 'restoreHistory', id: history.history[0].id })).ok, true);
    const state = await restored.request({ action: 'getLiveItems' });
    assert.equal(state.items.length, 3);
    assert.equal(state.scanState.status, 'restored');
    assert.equal((await restored.request({ action: 'restoreHistory', id: '../../file' })).ok, false);
  } finally { await restored.close(); }
});

test('candidate gate rejects stale, timestamp-free and invalid numeric evidence', () => {
  const vm = require('node:vm');
  const context = vm.createContext({});
  for (const file of ['constants', 'opportunity']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file + '.js'), 'utf8'), context);
  const now = Date.now();
  const item = { steamOrderbookAvailable: true, quickSellCostRate: 0.6, liquidityDays: 1,
    buffFetchedAt: now, steamVerifiedAt: now };
  assert.equal(context.isOpportunityCandidate(item), true);
  for (const changed of [{ steamVerifiedAt: null }, { buffFetchedAt: now - 31 * 60000 },
    { steamVerifiedAt: now - 31 * 60000 }, { steamVerifiedAt: now + 60000 },
    { quickSellCostRate: -1 }, { quickSellCostRate: NaN }, { liquidityDays: -1 }, { steamEnrichError: 'HTTP 429' }]) {
    assert.equal(context.isOpportunityCandidate({ ...item, ...changed }), false, JSON.stringify(changed));
  }
  assert.equal(context.calcLiquidityDays(null, 100), null);
});

test('history is bounded, preserves timestamps and restores multi-chunk snapshots atomically', async t => {
  const { store, directory } = storeFixture(t);
  const { createHistory, HISTORY_LIMIT } = require('../desktop/history');
  const history = createHistory(store);
  const firstItems = Array.from({ length: 510 }, (_, id) => ({ id, buffFetchedAt: 100, steamVerifiedAt: 200 }));
  for (let i = 0; i < 7; i++) {
    await store.set({ scanResult: { timestamp: `2026-10-15T00:0${i}:00Z`, game: 'csgo', scanMode: 'all', chunkCount: 2, totalItems: 510 },
      scanResult_chunk_0: firstItems.slice(0, 500), scanResult_chunk_1: firstItems.slice(500) });
    await history.archive();
  }
  assert.equal(history.list().length, HISTORY_LIMIT);
  assert.equal(history.list()[0].timestamp, '2026-10-15T00:06:00Z');
  assert.equal(history.list()[4].timestamp, '2026-10-15T00:02:00Z');
  assert.equal(history.list()[0].items, undefined); // IPC receives summaries, not huge snapshots.
  await history.archive();
  assert.equal(history.list().length, HISTORY_LIMIT);
  const selected = history.list()[4];
  await history.restore(selected.id);
  const reloaded = createStore(directory);
  assert.equal(reloaded.get('scanResult').scanResult.timestamp, selected.timestamp);
  assert.equal(reloaded.get('scanResult_chunk_1').scanResult_chunk_1.length, 10);
  assert.equal(reloaded.get('scanResult_chunk_0').scanResult_chunk_0[0].steamVerifiedAt, 200);
});

test('history restore and a second scan cannot race with archive preparation or enrichment', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let hold = false;
  const { engine } = engineFixture(t, { fetch: async (url, options) => {
    if (hold) await wait;
    return demoFetch(url, options);
  } });
  await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'current_page' });
  await until(engine, finished);
  hold = true;
  const starting = engine.request({ action: 'startScan', game: 'dota2', scanMode: 'current_page' });
  assert.equal((await engine.request({ action: 'startScan', game: 'csgo', scanMode: 'current_page' })).ok, false);
  await starting;
  const history = await engine.request({ action: 'listHistory' });
  assert.equal((await engine.request({ action: 'restoreHistory', id: history.history[0].id })).ok, false);
  release();
  await until(engine, finished);
});

const steamPageFixture = require('./fixtures/steam-market-pages.json');
function ssrPage({ currency = 13, name = steamPageFixture.marketHashName, appid = 570, overrides = {} } = {}) {
  const outer = structuredClone(steamPageFixture.ssr);
  const data = JSON.parse(outer.renderContext.queryData);
  data.queries[0].queryKey = ['market', 'orderbook', appid, name];
  Object.assign(data.queries[0].state.data, { eCurrency: currency }, overrides);
  outer.renderContext.queryData = JSON.stringify(data);
  return `<script type="application/json" id="valve-ssr-data">${JSON.stringify(outer)}</script>`;
}
async function verifyCapturedItem(engine, store) {
  await store.set({ scanResult: { game: 'dota2', items: [{ id: 965545, appid: 570, game: 'dota2',
    name: steamPageFixture.marketHashName, marketHashName: steamPageFixture.marketHashName,
    buffSellMinPrice: 1, buffFetchedAt: Date.now() }] } });
  await engine.request({ action: 'enrichSteam', itemIds: [965545], force: true });
  return until(engine, state => !state.isEnriching && state.items[0]?.steamAttemptedAt);
}

test('current Steam SSR page falls back to official legacy preference and obtains a CNY orderbook', async t => {
  let legacy = false;
  const preferences = [];
  const fetch = createMarketFetch({ cookies: { async set(value) { preferences.push(value); legacy = true; } },
    async fetch(url, options) {
      assert.equal(options.steamMarketLegacy, undefined);
      if (String(url).includes('/market/listings/')) return new Response(legacy ? steamPageFixture.legacy : ssrPage());
      if (String(url).includes('itemordershistogram')) {
        assert.equal(new URL(url).searchParams.get('currency'), '23');
        assert.equal(new URL(url).searchParams.get('item_nameid'), '176437079');
      }
      return demoFetch(url, options);
    } });
  const { engine, store } = engineFixture(t, { fetch });
  const state = await verifyCapturedItem(engine, store);
  assert.equal(state.items[0].steamOrderbookAvailable, true);
  assert.equal(state.items[0].steamOrderbookError, '');
  assert.ok(state.items[0].steamVerifiedAt);
  assert.equal(preferences.length, 1);
  assert.equal(preferences[0].name, 'bMarketOptOut');
  assert.equal(preferences[0].path, '/market');
  assert.equal(state.items[0].steamOrderbookSource, 'steam-order-histogram-cny');
});

test('new CNY SSR orderbook works without an item_nameid or legacy request', async t => {
  const { engine, store } = engineFixture(t, { fetch: (url, options) => {
    assert.equal(options?.steamMarketLegacy, undefined);
    assert.ok(!String(url).includes('itemordershistogram'));
    return String(url).includes('/market/listings/') ? Promise.resolve(new Response(ssrPage({ currency: 23 }))) : demoFetch(url, options);
  } });
  const state = await verifyCapturedItem(engine, store);
  assert.equal(state.items[0].steamBuyOrderPrice, 0.89);
  assert.equal(state.items[0].steamNameId, null);
  assert.ok(state.items[0].steamVerifiedAt);
  assert.equal(state.items[0].steamOrderbookSource, 'steam-ssr-cny');
});

test('foreign-currency, wrong-item and malformed SSR data never become CNY candidates', () => {
  const vm = require('node:vm');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/steam-market.js'), 'utf8'), context);
  for (const html of [ssrPage(), ssrPage({ currency: 23, name: 'different item' }), ssrPage({ currency: 23, appid: 730 }),
    ssrPage({ currency: 23, overrides: { amtMaxBuyOrder: -1 } }), ssrPage({ currency: 23, overrides: { amtMaxBuyOrder: null } }),
    '<script id="valve-ssr-data">not JSON</script>', '<html>Please log in</html>']) {
    assert.equal(context.parseSteamMarketPage(html, 570, steamPageFixture.marketHashName).kind, 'unavailable');
  }
  assert.equal(context.parseSteamMarketPage(ssrPage({ currency: 23 }), 570, steamPageFixture.marketHashName).kind, 'orderbook');
});

test('exact search can match beyond first result and refuses a similar variant', async t => {
  let mismatch = false;
  const { engine, store } = engineFixture(t, { fetch: (url, options) => {
    if (String(url).includes('search/render')) {
      assert.equal(new URL(url).searchParams.get('count'), '100');
      return Promise.resolve(Response.json({ success: true, results: [
        { hash_name: 'Inscribed ' + steamPageFixture.marketHashName, sell_listings: 999 },
        ...(mismatch ? [] : [{ hash_name: steamPageFixture.marketHashName, sell_listings: 150 }])
      ] }));
    }
    return demoFetch(url, options);
  } });
  let state = await verifyCapturedItem(engine, store);
  assert.equal(state.items[0].steamSellCount, 150);
  assert.ok(state.items[0].steamVerifiedAt);
  mismatch = true;
  await engine.request({ action: 'enrichSteam', itemIds: [965545], force: true });
  state = await until(engine, state => !state.isEnriching);
  assert.equal(state.items[0].steamSellCount, null);
  assert.equal(state.items[0].steamVerifiedAt, null);
});

test('legacy preference is scoped, cached and does not touch BUFF cookies', async () => {
  let changes = 0;
  const fetch = createMarketFetch({ cookies: { async set() { changes++; } }, fetch: async () => Response.json({}) });
  assert.throws(() => fetch('https://buff.163.com/api/market/goods', { steamMarketLegacy: true }));
  assert.throws(() => fetch('https://steamcommunity.com/market/buy', { steamMarketLegacy: true }));
  await fetch('https://steamcommunity.com/market/listings/570/Test', { steamMarketLegacy: true });
  await fetch('https://steamcommunity.com/market/listings/730/Test', { steamMarketLegacy: true });
  assert.equal(changes, 1);
});

test('exact orderbook total recovers a truncated fuzzy search without inventing volume', async t => {
  let noVolume = false;
  const { engine, store } = engineFixture(t, { fetch: async (url, options) => {
    if (String(url).includes('search/render')) return Response.json({ success: true, results: [{ hash_name: 'Different item', sell_listings: 999 }] });
    if (String(url).includes('priceoverview') && noVolume) return Response.json({ success: true, lowest_price: '¥ 115.00' });
    if (String(url).includes('itemordershistogram')) {
      const data = await (await demoFetch(url, options)).json();
      if (new URL(url).searchParams.get('norender') === '1') data.sell_order_count = '150';
      else data.sell_order_summary = '<span class="market_commodity_orders_header_promote">150</span> 个出售中，起价 <span class="market_commodity_orders_header_promote">¥ 115</span>';
      return Response.json(data);
    }
    return demoFetch(url, options);
  } });
  let state = await verifyCapturedItem(engine, store);
  assert.equal(state.items[0].steamSellCount, 150);
  assert.equal(state.items[0].steamEnrichError, '');
  assert.ok(state.items[0].steamVerifiedAt);
  noVolume = true;
  await engine.request({ action: 'enrichSteam', itemIds: [965545], force: true });
  state = await until(engine, state => !state.isEnriching);
  assert.equal(state.items[0].steamVerifiedAt, null);
  assert.equal(state.items[0].steamVolume, null);
  assert.equal(state.items[0].liquidityDays, null);
});
