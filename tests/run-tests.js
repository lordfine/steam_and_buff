// 简单单元测试 — 用 node 直接跑
// 不需要 vitest 等外部依赖
// 运行：node tests/run-tests.js

const path = require('path');
const fs = require('fs');

// 加载 lib 文件（calculator / constants）
const constantsCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'constants.js'), 'utf8');
const calculatorCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'calculator.js'), 'utf8');
const opportunityCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'opportunity.js'), 'utf8');

// calculator.js 顶层是 function 声明 + 用到 STEAM_TAX_RATE（来自 constants）
// 用 vm 注入到同一上下文
const vm = require('vm');
const ctx = vm.createContext({ module: { exports: {} } });
vm.runInContext(constantsCode, ctx);
vm.runInContext(calculatorCode, ctx);
vm.runInContext(opportunityCode, ctx);
const calc = ctx; // 函数都挂在 ctx 上

// constants 是 const 声明不暴露到 ctx，用 vm 把 const 注入到 ctx 后取
const constCtx = vm.createContext({});
vm.runInContext(constantsCode + '\nthis.GAMES = GAMES; this.BUFF_PAGE_SIZE = BUFF_PAGE_SIZE; this.STEAM_TAX_RATE = STEAM_TAX_RATE;', constCtx);
const constants = {
  GAMES: constCtx.GAMES,
  BUFF_PAGE_SIZE: constCtx.BUFF_PAGE_SIZE,
  STEAM_TAX_RATE: constCtx.STEAM_TAX_RATE
};
// 验证能取到
if (typeof calc.calcAfterTaxPrice !== 'function') {
  console.error('FAIL: calcAfterTaxPrice not loaded'); process.exit(2);
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'expected'} ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}
function assertClose(a, b, eps, msg) {
  if (Math.abs(a - b) > (eps ?? 1e-6)) throw new Error(`${msg || ''} ${a} not close to ${b}`);
}

console.log('\n=== calculator.js ===\n');

test('calcAfterTaxPrice: 100 CNY → 86.9565...', () => {
  // steamPrice / (1 + 0.15) = 100 / 1.15 ≈ 86.9565
  const r = calc.calcAfterTaxPrice(100);
  assertClose(r, 100 / 1.15, 1e-4);
});

test('calcAfterTaxPrice: 0', () => {
  assertEq(calc.calcAfterTaxPrice(0), 0);
});

test('calcBalanceRatio: buff=50 steam=100', () => {
  // afterTax = 100/1.15 ≈ 86.9565
  // ratio = 50 / 86.9565 ≈ 0.575
  const r = calc.calcBalanceRatio(50, 100);
  assert(r !== null && r > 0);
  assertClose(r, 50 / (100 / 1.15), 1e-4);
});

test('calcBalanceRatio: steam=0 → null', () => {
  assertEq(calc.calcBalanceRatio(50, 0), null);
});

test('calcBalanceRatio: undefined steam → null', () => {
  assertEq(calc.calcBalanceRatio(50, undefined), null);
});

test('parseSteamPrice: "¥12.50" → 12.5', () => {
  assertEq(calc.parseSteamPrice('¥12.50'), 12.5);
});

test('parseSteamPrice: "1,234.56" → 1234.56', () => {
  assertEq(calc.parseSteamPrice('1,234.56'), 1234.56);
});

test('parseSteamPrice: null → 0', () => {
  assertEq(calc.parseSteamPrice(null), 0);
});

test('parseSteamPrice: "--" → 0', () => {
  assertEq(calc.parseSteamPrice('--'), 0);
});

test('Steam net proceeds: 115 gross → 100 wallet estimate', () => {
  assertEq(ctx.getSteamNetPrice(115), 100);
});

test('75 yuan to 100 wallet is a 0.75 cost rate', () => {
  assertClose(ctx.calcCostRate(75, 115), 0.75, 1e-9);
  assertClose(ctx.calcReturnMultiple(75, 115), 100 / 75, 1e-9);
});

test('liquidity coverage uses active listings / 24h volume', () => {
  assertEq(ctx.calcLiquidityDays(90, 30), 3);
  assertEq(ctx.calcLiquidityDays(90, 0), null);
});

test('Steam order histogram minor units convert to CNY', () => {
  assertEq(ctx.parseSteamOrderPrice('1250'), 12.5);
  assertEq(ctx.parseOrderSummaryCount('1,234 buy orders'), 1234);
});

test('precise search matches Steam market names and all query tokens', () => {
  const item = { name: 'AK-47 | Redline', marketHashName: 'AK-47 | Redline (Field-Tested)', game: 'csgo' };
  assertEq(ctx.matchesItemSearch(item, 'AK Redline field tested'), true);
  assertEq(ctx.rankItemSearch(item, 'AK-47 | Redline (Field-Tested)'), 0);
  assertEq(ctx.matchesItemSearch(item, 'dragon lore'), false);
});

test('candidate gate requires confirmed orderbook, cost rate and 3-day liquidity', () => {
  const item = { steamOrderbookAvailable: true, quickSellCostRate: 0.75, liquidityDays: 3, buffFetchedAt: Date.now(), steamVerifiedAt: Date.now() };
  assertEq(ctx.isOpportunityCandidate(item), true);
  assertEq(ctx.isOpportunityCandidate({ ...item, steamOrderbookAvailable: false }), false);
  assertEq(ctx.isOpportunityCandidate({ ...item, quickSellCostRate: 0.76 }), false);
  assertEq(ctx.isOpportunityCandidate({ ...item, liquidityDays: 3.1 }), false);
});

test('enrichment preview keeps the best unverified candidates visible while scanning Steam', () => {
  const rows = ctx.getPendingOpportunityItems([
    { id: 1, sellRatio: 0.70, buffSellNum: 2, steamEnriched: false },
    { id: 2, sellRatio: 0.72, buffSellNum: 8, steamEnriched: false },
    { id: 3, sellRatio: 0.60, buffSellNum: 1, steamEnriched: true },
    { id: 4, sellRatio: 0.80, buffSellNum: 5, steamEnriched: false }
  ], { maxCostRate: 0.75, limit: 20 });
  assertEq(rows.map(row => row.id).join(','), '1,2');
});

test('calcItemData: 完整物品', () => {
  const buffItem = {
    id: 12345,
    name: 'AK-47 | Redline (Field-Tested)',
    short_name: 'AK-47 | Redline',
    market_hash_name: 'AK-47 | Redline (Field-Tested)',
    game: 'csgo',
    appid: 730,
    sell_min_price: '50.00',
    buy_max_price: '40.00',
    sell_num: 10,
    buy_num: 5,
    goods_info: {
      steam_price_cny: '60.00',
      steam_price: '8.50',
      icon_url: 'http://example.com/icon.png'
    },
    steam_market_url: 'https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20%28Field-Tested%29'
  };
  const item = calc.calcItemData(buffItem);
  assertEq(item.id, 12345);
  assertEq(item.shortName, 'AK-47 | Redline');
  assertEq(item.buffSellMinPrice, 50);
  assertEq(item.buffBuyMaxPrice, 40);
  assertEq(item.steamPriceCny, 60);
  assertClose(item.afterTaxPrice, 60 / 1.15, 1e-4);
  // sellRatio = 50 / (60/1.15) ≈ 0.958
  assert(item.sellRatio !== null && item.sellRatio > 0.9 && item.sellRatio < 1.0);
  assertEq(item.profitable, true);  // 0.958 < 1
  assertEq(item.steamEnriched, false);
  assertEq(item.steamUnsupported, false);
  assertEq(item.enrichedAt, null);
});

test('calcItemData: 无 steam_price → profitable=false', () => {
  const buffItem = {
    id: 1, name: 'X', short_name: 'X', market_hash_name: 'X',
    game: 'csgo', appid: 730,
    sell_min_price: '10', buy_max_price: '5',
    sell_num: 1, buy_num: 1,
    goods_info: {}
  };
  const item = calc.calcItemData(buffItem);
  assertEq(item.steamPriceCny, 0);
  assertEq(item.afterTaxPrice, 0);
  assertEq(item.sellRatio, null);
  assertEq(item.profitable, false);
});

test('calcItemData: 防御 parseFloat undefined 字段', () => {
  const buffItem = {
    id: 1, name: 'X', short_name: 'X', market_hash_name: 'X',
    game: 'csgo', appid: 730,
    sell_min_price: undefined, buy_max_price: undefined,
    sell_num: undefined, buy_num: undefined,
    goods_info: {}
  };
  const item = calc.calcItemData(buffItem);
  assertEq(item.buffSellMinPrice, 0);
  assertEq(item.buffBuyMaxPrice, 0);
  assertEq(item.buffSellNum, 0);
});

console.log('\n=== constants.js ===\n');

test('GAMES 包含 dota2/csgo', () => {
  assert(constants.GAMES.dota2.appid === 570);
  assert(constants.GAMES.csgo.appid === 730);
});

test('BUFF_PAGE_SIZE = 80', () => {
  assertEq(constants.BUFF_PAGE_SIZE, 80);
});

test('STEAM_TAX_RATE = 0.15', () => {
  assertEq(constants.STEAM_TAX_RATE, 0.15);
});

console.log('\n=== classifyError (mock) ===\n');

// classifyError 在 background.js 里不容易独立加载，直接复制逻辑测
function classifyError(e) {
  const msg = e?.message || '';
  if (e?.name === 'AbortError') return 'abort';
  if (/429|rate.?limit/i.test(msg)) return 'rate_limit';
  if (/404/.test(msg)) return 'not_found';
  if (/item_nameid not found/.test(msg)) return 'not_found';
  if (/5\d\d/.test(msg)) return 'server';
  if (e instanceof TypeError || /failed to fetch|network|load failed/i.test(msg)) return 'network';
  return 'unknown';
}

test('classifyError: AbortError → abort', () => {
  const e = new Error('x'); e.name = 'AbortError';
  assertEq(classifyError(e), 'abort');
});

test('classifyError: 429 → rate_limit', () => {
  assertEq(classifyError(new Error('HTTP 429 (rate limited)')), 'rate_limit');
});

test('classifyError: 404 → not_found', () => {
  assertEq(classifyError(new Error('HTTP 404 (item not on Steam Market)')), 'not_found');
});

test('classifyError: 500 → server', () => {
  assertEq(classifyError(new Error('HTTP 500')), 'server');
});

test('classifyError: TypeError → network', () => {
  assertEq(classifyError(new TypeError('Failed to fetch')), 'network');
});

test('classifyError: item_nameid not found → not_found', () => {
  assertEq(classifyError(new Error('item_nameid not found in listing page')), 'not_found');
});

test('classifyError: 其它 → unknown', () => {
  assertEq(classifyError(new Error('something weird')), 'unknown');
});

console.log('\n=== escapeHtml (mock) ===\n');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

test('escapeHtml: <script>', () => {
  assertEq(escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml: 引号', () => {
  assertEq(escapeHtml('a"b\'c'), 'a&quot;b&#39;c');
});

test('escapeHtml: null/undefined', () => {
  assertEq(escapeHtml(null), '');
  assertEq(escapeHtml(undefined), '');
});

test('escapeHtml: 普通文本不变', () => {
  assertEq(escapeHtml('AK-47 | Redline'), 'AK-47 | Redline');
});

test('escapeHtml: &amp;', () => {
  assertEq(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
