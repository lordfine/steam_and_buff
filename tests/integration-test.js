// 集成测试：模拟数据流，不依赖 Chrome API
// 运行：node tests/integration-test.js

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const constantsCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'constants.js'), 'utf8');
const calculatorCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'calculator.js'), 'utf8');
const opportunityCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'opportunity.js'), 'utf8');
const domCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dom.js'), 'utf8');

let passed = 0, failed = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// 模拟 chrome.storage.local（用内存 Map）
const storageLocal = {};
const storageListeners = [];
const fakeChrome = {
  storage: {
    local: {
      get(keys, cb) {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of keyArr) out[k] = storageLocal[k];
        if (cb) cb(out);
      },
      set(obj, cb) {
        // 模拟配额：超过 1MB 报错
        const totalSize = JSON.stringify(obj).length;
        if (totalSize > 1_000_000) {
          const err = new Error('QUOTA_BYTES quota exceeded');
          if (cb) cb(err);
          return;
        }
        Object.assign(storageLocal, obj);
        if (cb) cb();
      },
      remove(keys, cb) {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keyArr) delete storageLocal[k];
        if (cb) cb();
      },
      clear(cb) {
        for (const k of Object.keys(storageLocal)) delete storageLocal[k];
        if (cb) cb();
      }
    },
    onChanged: { addListener(fn) { storageListeners.push(fn); } }
  },
  cookies: { getAll: () => [] },
  alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
  runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {}, lastError: null }
};

// 加载 storage.js（它是顶层函数声明）
const storageCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storage.js'), 'utf8');
const ctx = vm.createContext({ chrome: fakeChrome, console });
vm.runInContext(constantsCode, ctx);
vm.runInContext(storageCode, ctx);
vm.runInContext(calculatorCode, ctx);
vm.runInContext(opportunityCode + '\nthis.calcAfterTaxPrice = calcAfterTaxPrice; this.calcBalanceRatio = calcBalanceRatio; this.parseSteamPrice = parseSteamPrice; this.calcItemData = calcItemData; this.getSteamNetPrice = getSteamNetPrice; this.calcCostRate = calcCostRate; this.calcLiquidityDays = calcLiquidityDays; this.isOpportunityCandidate = isOpportunityCandidate;', ctx);

// 现在 ctx 上有 saveData / saveScanResult / loadScanResult + calculator 函数等

console.log('\n=== storage: saveScanResult / loadScanResult ===\n');

test('save 100 件 + load 完整恢复', async () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: i, name: `Item ${i}`, buffSellMinPrice: 10 + i, sellRatio: 0.9, profitable: true
  }));
  await ctx.saveScanResult({
    timestamp: '2026-08-04T00:00:00.000Z',
    game: 'dota2', scanMode: 'all',
    items, stats: { scannedItems: 100, profitableItems: 50 }
  });
  const loaded = await ctx.loadScanResult();
  assertEq(loaded.items.length, 100);
  assertEq(loaded.items[0].id, 0);
  assertEq(loaded.items[99].id, 99);
  assertEq(loaded.timestamp, '2026-08-04T00:00:00.000Z');
  assertEq(loaded.game, 'dota2');
});

test('save 大数据集 (5000 件) → 分块 + 加载', async () => {
  for (const k of Object.keys(storageLocal)) delete storageLocal[k];
  const items = Array.from({ length: 5000 }, (_, i) => ({
    id: i, name: `Item ${i}`, buffSellMinPrice: 1, sellRatio: 0.5
  }));
  await ctx.saveScanResult({
    timestamp: '2026-08-04T00:00:00.000Z',
    game: 'csgo', scanMode: 'all', items, stats: {}
  });
  // chunkCount = ceil(5000/500) = 10
  const meta = storageLocal.scanResult;
  assertEq(meta.chunkCount, 10);
  const loaded = await ctx.loadScanResult();
  assertEq(loaded.items.length, 5000);
});

test('save 后再 save 更小数据集 → 旧 chunks 被清理', async () => {
  for (const k of Object.keys(storageLocal)) delete storageLocal[k];
  const big = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: 'big' }));
  await ctx.saveScanResult({ timestamp: 't1', game: 'g', items: big, stats: {} });
  const keysAfterBig = Object.keys(storageLocal).filter(k => k.startsWith('scanResult_chunk_')).length;
  assertEq(keysAfterBig, 4);

  const small = Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'small' }));
  await ctx.saveScanResult({ timestamp: 't2', game: 'g', items: small, stats: {} });
  const keysAfterSmall = Object.keys(storageLocal).filter(k => k.startsWith('scanResult_chunk_')).length;
  assertEq(keysAfterSmall, 1);
  // 旧 chunk_2, chunk_3 已被清理
  assert(!storageLocal.scanResult_chunk_2);
  assert(!storageLocal.scanResult_chunk_3);
});

test('saveScanState: state 带 heartbeat', async () => {
  const state = {
    status: 'running', currentPage: 5, scannedItems: 400,
    startTime: Date.now(), heartbeat: Date.now()
  };
  await ctx.saveScanState(state);
  const loaded = await ctx.loadData('scanState');
  assertEq(loaded.status, 'running');
  assertEq(loaded.currentPage, 5);
  assert(loaded.heartbeat > 0);
});

console.log('\n=== calculator + enrichment 流程模拟 ===\n');

test('calcItemData 完整流程', () => {
  const buffItem = {
    id: 999, name: 'AWP | Dragon Lore (Factory New)',
    short_name: 'AWP | Dragon Lore',
    market_hash_name: 'AWP | Dragon Lore (Factory New)',
    game: 'csgo', appid: 730,
    sell_min_price: '12000.00', buy_max_price: '11500.00',
    sell_num: 3, buy_num: 1,
    goods_info: {
      steam_price_cny: '12500.00',
      steam_price: '1770.00',
      icon_url: 'http://example.com/awp.png'
    },
    steam_market_url: 'https://steamcommunity.com/market/listings/730/AWP%20%7C%20Dragon%20Lore%20%28Factory%20New%29'
  };
  const item = ctx.calcItemData(buffItem);
  assertEq(item.id, 999);
  assertEq(item.steamPriceCny, 12500);
  assertEq(item.buffSellMinPrice, 12000);
  // ratio = 12000 / (12500/1.15) ≈ 1.104
  assert(item.sellRatio > 1.0 && item.sellRatio < 1.15);
  // ratio > 1 → profitable = false
  assertEq(item.profitable, false);
  // 防御字段
  assertEq(item.steamEnriched, false);
  assertEq(item.steamUnsupported, false);
  assertEq(item.enrichedAt, null);
});

test('enrichment 数据合并：Steam price + histogram', () => {
  // 模拟 enrichment 后的 item (buffSellMinPrice < afterTax → profitable)
  const baseItem = ctx.calcItemData({
    id: 1, name: 'AK-47 | Redline (FT)', short_name: 'AK-47 | Redline',
    market_hash_name: 'AK-47 | Redline (Field-Tested)',
    game: 'csgo', appid: 730,
    sell_min_price: '40', buy_max_price: '35', sell_num: 5, buy_num: 2,
    goods_info: { steam_price_cny: '55' }
  });

  // 模拟 fetchSteamPriceOverview + fetchSteamOrderHistogram 的返回
  const priceData = { success: true, lowest_price: '¥52.50', volume: '1,234' };
  const orderData = { success: 1, sell_order_count: '47', buy_order_count: '12', highest_buy_order: '¥45.00' };

  // 应用 enrichment 逻辑
  const steamPrice = ctx.parseSteamPrice(priceData.lowest_price);
  assertEq(steamPrice, 52.5);
  baseItem.steamPriceCny = steamPrice;
  baseItem.afterTaxPrice = ctx.calcAfterTaxPrice(steamPrice);
  baseItem.sellRatio = ctx.calcBalanceRatio(baseItem.buffSellMinPrice, steamPrice);
  baseItem.profitable = baseItem.sellRatio !== null && baseItem.sellRatio < 1;
  baseItem.steamVolume = parseInt(priceData.volume.replace(/,/g, '')) || 0;

  baseItem.steamSellCount = parseInt(orderData.sell_order_count) || 0;
  baseItem.steamBuyCount = parseInt(orderData.buy_order_count) || 0;
  baseItem.steamBuyOrderPrice = ctx.parseSteamPrice(orderData.highest_buy_order);
  baseItem.steamEnriched = true;
  baseItem.enrichedAt = Date.now();

  assertEq(baseItem.steamSellCount, 47);
  assertEq(baseItem.steamBuyCount, 12);
  assertEq(baseItem.steamBuyOrderPrice, 45);
  assertEq(baseItem.steamVolume, 1234);
  assert(baseItem.sellRatio < 1);
  assertEq(baseItem.profitable, true);
  assert(baseItem.enrichedAt > 0);
});

console.log('\n=== CSV 导出安全性 ===\n');

test('机会筛选：成本率 0.75 且供给覆盖 3 天时入选', () => {
  assertEq(ctx.isOpportunityCandidate({
    buffFetchedAt: Date.now(), steamVerifiedAt: Date.now(),
    steamOrderbookAvailable: true,
    quickSellCostRate: 0.75,
    liquidityDays: ctx.calcLiquidityDays(90, 30)
  }), true);
});

// 直接复制 dashboard.js 的 escapeCSVCell 逻辑来测试
function escapeCSVCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

test('CSV: 普通名称', () => {
  assertEq(escapeCSVCell('AK-47 | Redline'), '"AK-47 | Redline"');
});

test('CSV: =SUM(A1) 注入 → 被前缀单引号', () => {
  assertEq(escapeCSVCell('=SUM(A1:A10)'), '"\'=SUM(A1:A10)"');
});

test('CSV: +CMD|/c calc → 前缀单引号', () => {
  assertEq(escapeCSVCell('+CMD|/c calc'), '"\'+CMD|/c calc"');
});

test('CSV: @SUM → 前缀单引号', () => {
  assertEq(escapeCSVCell('@SUM(1+1)*cmd'), '"\'@SUM(1+1)*cmd"');
});

test('CSV: 内部双引号 → 双引号转义', () => {
  assertEq(escapeCSVCell('say "hi"'), '"say ""hi"""');
});

test('CSV: 数字', () => {
  assertEq(escapeCSVCell(123.45), '"123.45"');
});

test('CSV: null/undefined → 空', () => {
  assertEq(escapeCSVCell(null), '');
  assertEq(escapeCSVCell(undefined), '');
});

test('CSV: 含逗号的名称', () => {
  assertEq(escapeCSVCell('a, b, c'), '"a, b, c"');
});

console.log('\n=== DOM 工具 (jsdom 模拟) ===\n');

// 简单 DOM mock - 验证 el() 输出结构
const fakeDoc = {
  createElement: (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      attributes: {},
      _listeners: {},
      _textContent: '',
      _innerHTML: '',
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        return child;
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; },
      removeAttribute(k) { delete this.attributes[k]; },
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      set className(v) { this.attributes.class = v; },
      get className() { return this.attributes.class; },
      set textContent(v) { this._textContent = v; },
      get textContent() { return this._textContent; },
      set innerHTML(v) { this._innerHTML = v; },
      get innerHTML() { return this._innerHTML; },
      set classList(v) {},
      get dataset() { return this._dataset || (this._dataset = {}); }
    };
    Object.defineProperty(node, 'firstChild', {
      get() { return this.children[0] || null; }
    });
    return node;
  },
  createTextNode(s) { return { nodeType: 3, textContent: s }; }
};

// 把 fakeDoc 注入 dom.js 上下文
const domCtx = vm.createContext({
  document: fakeDoc,
  Node: function Node() {},  // 占位，el() 用 instanceof Node 判断
});
// Node 在 dom.js 里用于 `child instanceof Node` - 用一个类作占位
function FakeNode() {}
FakeNode.prototype = { nodeType: 1 };
domCtx.Node = FakeNode;
vm.runInContext(domCode, domCtx);
const { el, escapeHtml: domEscapeHtml, safeUrl, clearChildren } = domCtx;

test('el(): 创建带 class 的 div', () => {
  const n = el('div', { class: 'foo' }, 'hello');
  assertEq(n.tagName, 'DIV');
  assertEq(n.attributes.class, 'foo');
  assertEq(n.children[0].textContent, 'hello');
});

test('el(): title 属性不被 XSS', () => {
  const xss = '<script>alert(1)</script>';
  const n = el('div', { title: xss }, xss);
  // setAttribute 接收原始字符串，浏览器负责转义
  // 关键是不能用 innerHTML 拼接
  assertEq(n.attributes.title, xss);  // setAttribute 是安全的
  assertEq(n.children[0].textContent, xss);  // textContent 是安全的
});

test('el(): safeUrl 只允许 http(s)', () => {
  assertEq(safeUrl('https://steamcommunity.com/market/x'), 'https://steamcommunity.com/market/x');
  assertEq(safeUrl('http://example.com'), 'http://example.com');
  assertEq(safeUrl('javascript:alert(1)'), '');
  assertEq(safeUrl('data:text/html,<script>'), '');
  assertEq(safeUrl(null), '');
});

test('el(): href 通过 safeUrl', () => {
  const n = el('a', { href: 'javascript:alert(1)' }, 'click');
  assertEq(n.attributes.href, undefined);  // 被移除
});

test('el(): onClick 自动 addEventListener', () => {
  let clicked = false;
  const fn = () => { clicked = true; };
  const n = el('button', { onClick: fn });
  assert(n._listeners.click && n._listeners.click[0] === fn);
  n._listeners.click[0]();
  assertEq(clicked, true);
});

test('escapeHtml (in dom.js): 全覆盖', () => {
  assertEq(domEscapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  assertEq(domEscapeHtml('AK-47'), 'AK-47');
});

test('clearChildren: 清空', () => {
  const n = el('div', {}, 'a', 'b');
  assertEq(n.children.length, 2);
  clearChildren(n);
  assertEq(n.children.length, 0);
});

(async () => {
  for (const { name, fn } of cases) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (error) { console.error(`  ✗ ${name}\n    ${error.stack}`); failed++; }
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exitCode = failed ? 1 : 0;
})();
