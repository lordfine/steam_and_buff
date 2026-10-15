importScripts(
  'lib/constants.js',
  'lib/calculator.js',
  'lib/opportunity.js',
  'lib/steam-market.js',
  'lib/extension-transport.js',
  'lib/storage.js'
);

// alarm 唤醒 SW + 更新 scanState heartbeat，避免 idle 30s 回收
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sw-keepalive' && (isScanning || isEnriching)) {
    try {
      const saved = await loadData(STORAGE_KEYS.SCAN_STATE);
      if (isScanning && saved && saved.status === 'running') {
        saved.heartbeat = Date.now();
        saved.currentPage = liveScanInfo.page;
        saved.scannedItems = liveItems.length;
        await saveData(STORAGE_KEYS.SCAN_STATE, saved);
      }
    } catch (_) { /* ignore */ }
  }
});

let scanAbortController = null;
let isScanning = false;
let liveItems = [];
let liveStats = { totalItems: 0, scannedItems: 0, profitableItems: 0, enrichFailed: 0, enrichSkipped: 0, quotaExceeded: false };
let liveScanInfo = { game: '', scanMode: 'all', page: 0, totalPages: 0, startTime: 0, timestamp: 0 };

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function isQuotaError(e) {
  return e && /QUOTA_BYTES|QUOTA_EXCEEDED|quota/i.test(e.message || '');
}

function markQuotaExceeded() {
  liveStats.quotaExceeded = true;
}

function startKeepAlive() {
  // MV3 alarms have a 30s minimum on current Chrome versions.
  chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.5 });
}

function stopKeepAlive() {
  chrome.alarms.clear('sw-keepalive');
}

async function fetchWithRetry(url, options = {}, { retries = 3, baseDelay = 2000 } = {}, externalSignal) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const resp = await fetchMarket(url, { ...options, signal: externalSignal });
      if (resp.status === 429) {
        // 尊重服务端 Retry-After
        const retryAfter = parseInt(resp.headers.get('Retry-After'), 10);
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : baseDelay * Math.pow(2, attempt);
        if (attempt < retries) {
          await sleep(Math.min(waitMs, 60_000), externalSignal);
          continue;
        }
        throw new Error(`HTTP 429 (rate limited)`);
      }
      if (resp.status >= 500 && resp.status < 600) {
        if (attempt < retries) {
          await sleep(baseDelay * Math.pow(2, attempt), externalSignal);
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') throw e;
      // 网络错误：重试
      if (attempt < retries && (e instanceof TypeError || /failed to fetch|network/i.test(e.message || ''))) {
        await sleep(baseDelay * Math.pow(2, attempt), externalSignal);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetchWithRetry: exhausted');
}

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

async function fetchBuffPage(game, pageNum, signal) {
  const url = `${BUFF_API_BASE}?game=${game}&page_num=${pageNum}&page_size=${BUFF_PAGE_SIZE}`;
  const resp = await fetchWithRetry(url, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json'
    }
  }, { retries: BUFF_MAX_RETRIES, baseDelay: BUFF_RETRY_BASE_DELAY }, signal);
  if (!resp.ok) throw new Error(`BUFF API HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 'OK') {
    if (/login|required|unauthor/i.test(`${data.code || ''} ${data.error || ''}`)) {
      throw new Error('BUFF API 返回未授权（Login Required）。请在当前应用使用的 BUFF 登录窗口完成登录后重试。');
    }
    throw new Error(`BUFF API: ${data.code} - ${data.error}`);
  }
  return data;
}

async function startScan(game, scanMode) {
  if (isScanning || isEnriching) {
    return { ok: false, error: '扫描或行情复核正在进行' };
  }

  isScanning = true;
  liveItems = [];
  liveStats = { totalItems: 0, scannedItems: 0, profitableItems: 0, enrichFailed: 0, enrichSkipped: 0, quotaExceeded: false };
  liveScanInfo = { game, scanMode, page: 0, totalPages: 0, startTime: Date.now(), timestamp: 0 };
  scanAbortController = new AbortController();
  const signal = scanAbortController.signal;
  startKeepAlive();

  const state = {
    game,
    scanMode,
    status: 'running',
    totalItems: 0,
    scannedItems: 0,
    currentPage: 1,
    startTime: Date.now(),
    heartbeat: Date.now()
  };
  try {
    await saveScanState(state);
    if (scanMode === 'current_page') {
      const page = await getActiveBuffPageNumber();
      await scanCurrentPage(game, signal, state, page);
    } else {
      await scanAll(game, signal, state);
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      state.status = 'cancelled';
      await saveScanState(state);
    } else {
      state.status = 'error';
      state.error = e.message;
      await saveScanState(state);
    }
  } finally {
    // Save even a short, cancelled scan (the extension previously lost <800 items).
    if (state.status !== 'completed') {
      if (liveItems.length) await saveCurrentScanResult();
      else {
        // No new data: keep the last successful snapshot, even across restart.
        liveScanInfo.startTime = 0;
        state.keptPreviousResult = true;
        await saveScanState(state);
      }
    }
    isScanning = false;
    scanAbortController = null;
    stopKeepAlive();
  }

  // Manual scan automatically verifies the best BUFF-price candidates on Steam.
  // Keep the request budget bounded; users can refresh the shortlist later.
  if (state.status === 'completed') {
    const shortlist = [...liveItems]
      .filter(item => item.sellRatio !== null && item.sellRatio <= DEFAULT_COST_RATE)
      .sort((a, b) => (a.sellRatio - b.sellRatio) || (b.buffSellNum - a.buffSellNum))
      .slice(0, STEAM_ENRICH_BATCH_SIZE)
      .map(item => item.id);
    if (shortlist.length) await enrichItemsWithSteam(shortlist);
  }
}

async function getActiveBuffPageNumber() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.url.startsWith('https://buff.163.com/')) return 1;
    const url = new URL(tab.url);
    const page = Number.parseInt(url.searchParams.get('page_num') || url.searchParams.get('page') || '1', 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch (_) {
    return 1;
  }
}

async function scanAll(game, signal, state) {
  const BUFF_CONCURRENCY = 2;
  const firstPage = await fetchBuffPage(game, 1, signal);
  const totalCount = firstPage.data.total_count;
  const totalPages = Math.ceil(totalCount / BUFF_PAGE_SIZE);

  state.totalItems = totalCount;
  liveScanInfo.totalPages = totalPages;
  await saveScanState(state);

  let savedItemCount = 0;

  // 处理第一页
  await processPage(firstPage, 1, game, state, () => savedItemCount, (n) => { savedItemCount = n; });

  // 并发 worker pool 处理剩余页
  let nextPage = 2;
  const workers = [];
  for (let w = 0; w < BUFF_CONCURRENCY; w++) {
    workers.push((async () => {
      while (true) {
        if (signal.aborted) return;
        const page = nextPage++;
        if (page > totalPages) return;
        if (signal.aborted) return;
        await sleep(BUFF_REQUEST_INTERVAL, signal);
        if (signal.aborted) return;
        try {
          const pageData = await fetchBuffPage(game, page, signal);
          await processPage(pageData, page, game, state, () => savedItemCount, (n) => { savedItemCount = n; });
        } catch (e) {
          if (e.name === 'AbortError') return;
          scanAbortController?.abort();
          throw e;
        }
      }
    })());
  }

  // Wait for all workers before allowing a new scan; failed workers must not
  // continue writing into the next run's liveItems array.
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find(result => result.status === 'rejected' && result.reason?.name !== 'AbortError')
    || outcomes.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;

  if (signal.aborted) {
    state.status = 'cancelled';
    await saveScanState(state);
    return;
  }

  const result = {
    timestamp: new Date().toISOString(),
    game,
    scanMode: 'all',
    items: liveItems,
    stats: { ...liveStats }
  };

  try {
    await saveScanResult(result);
  } catch (e) {
    console.error('Final save failed:', e);
    if (isQuotaError(e)) markQuotaExceeded();
  }
  state.status = 'completed';
  state.timestamp = result.timestamp;
  liveScanInfo.timestamp = result.timestamp;
  liveScanInfo.scanMode = 'all';
  await saveScanState(state);
}

async function processPage(pageData, page, game, state, getSavedCount, setSavedCount) {
  const items = pageData.data.items || [];
  for (const buffItem of items) {
    liveItems.push(calcItemData(buffItem));
  }

  liveScanInfo.page = page;
  liveStats.totalItems = state.totalItems;
  liveStats.scannedItems = liveItems.length;
  liveStats.profitableItems = liveItems.filter(i => i.sellRatio !== null && i.sellRatio <= DEFAULT_COST_RATE).length;

  state.scannedItems = liveItems.length;
  state.currentPage = page;
  await saveScanState(state);

  if (liveItems.length - getSavedCount() >= 800) {
    setSavedCount(liveItems.length);
    try {
      await saveScanResult({
        timestamp: new Date().toISOString(),
        game,
        scanMode: 'all',
        items: liveItems,
        stats: { ...liveStats }
      });
    } catch (e) {
      console.error('Incremental save failed:', e);
      if (isQuotaError(e)) markQuotaExceeded();
    }
  }
}

async function scanCurrentPage(game, signal, state, pageNum = 1) {
  const pageData = await fetchBuffPage(game, pageNum, signal);
  const items = pageData.data.items || [];
  liveItems = items.map(buffItem => calcItemData(buffItem));

  liveStats.totalItems = items.length;
  liveStats.scannedItems = liveItems.length;
  liveStats.profitableItems = liveItems.filter(i => i.sellRatio !== null && i.sellRatio <= DEFAULT_COST_RATE).length;
  liveScanInfo.page = pageNum;
  liveScanInfo.totalPages = 1;

  const result = {
    timestamp: new Date().toISOString(),
    game,
    scanMode: 'current_page',
    items: liveItems,
    stats: { ...liveStats }
  };

  await saveScanResult(result);
  state.status = 'completed';
  state.scannedItems = items.length;
  state.totalItems = items.length;
  state.timestamp = result.timestamp;
  liveScanInfo.timestamp = result.timestamp;
  liveScanInfo.scanMode = 'current_page';
  await saveScanState(state);
}

let enrichAbortController = null;
let isEnriching = false;
let enrichProgress = { done: 0, total: 0 };

async function fetchSteamPriceOverview(appid, marketHashName, signal) {
  const url = `${STEAM_PRICE_API}?currency=${STEAM_CURRENCY_CNY}&appid=${appid}&market_hash_name=${encodeURIComponent(marketHashName)}`;
  const resp = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, { retries: 3, baseDelay: 2000 }, signal);
  if (!resp.ok) throw new Error(`Steam API HTTP ${resp.status}`);
  return resp.json();
}

// 用 search/render 拿 sell_listings + sell_price
// search/render accepts market_hash_name + appid; the separate orderbook call
// still needs item_nameid, which is best-effort extracted from the listing HTML.
async function fetchSteamSearchRender(appid, marketHashName, signal) {
  // Similar variants may rank ahead of the exact item. Use a bounded single-page
  // search, then enforce exact hash-name equality (never silently use row one).
  const url = `${STEAM_SEARCH_API}?query=${encodeURIComponent(marketHashName)}&start=0&count=100&appid=${appid}&norender=1`;
  const resp = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, { retries: 3, baseDelay: 2000 }, signal);
  if (!resp.ok) {
    if (resp.status === 404) throw new Error('HTTP 404 (item not on Steam Market)');
    throw new Error(`Steam search API HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.success || !Array.isArray(data.results) || data.results.length === 0) {
    throw new Error('item not found in search results');
  }
  // 验证 hash_name 完全匹配（搜索可能返回相似物品）
  const match = data.results.find(r => r.hash_name === marketHashName);
  if (!match) throw new Error('exact item not found in search results');
  return match;
}

function buildSteamListingUrl(appid, marketHashName) {
  return `https://steamcommunity.com/market/listings/${appid}/${encodeURIComponent(marketHashName)}`;
}

async function getSteamOrderBookSource(appid, marketHashName, signal) {
  const cache = await loadData(STORAGE_KEYS.STEAM_NAME_IDS) || {};
  const cacheKey = `${appid}:${marketHashName}`;
  const cached = Number(cache[cacheKey]);
  if (Number.isSafeInteger(cached) && cached > 0) return { kind: 'legacy', itemNameId: cached };

  const listingUrl = buildSteamListingUrl(appid, marketHashName);
  const response = await fetchWithRetry(listingUrl, {
    headers: { 'Accept': 'text/html' }
  }, { retries: 2, baseDelay: 3000 }, signal);
  if (!response.ok) throw new Error(`Steam listing page HTTP ${response.status}`);
  let source = parseSteamMarketPage(await response.text(), appid, marketHashName, STEAM_CURRENCY_CNY);
  if (source.kind === 'unavailable') {
    // Desktop transport enables Steam's documented-by-UI "Exit Market Beta"
    // preference in its isolated session. No auth cookie is read or exported.
    const legacyResponse = await fetchWithRetry(listingUrl, {
      headers: { Accept: 'text/html' }, steamMarketLegacy: true
    }, { retries: 1, baseDelay: 3000 }, signal);
    if (!legacyResponse.ok) throw new Error(`Steam 兼容页面 HTTP ${legacyResponse.status}`);
    const fallback = parseSteamMarketPage(await legacyResponse.text(), appid, marketHashName, STEAM_CURRENCY_CNY);
    if (fallback.kind === 'unavailable') throw new Error(`Steam 求购盘读取失败：${source.reason}；兼容读取也未成功`);
    source = fallback;
  }
  if (source.kind === 'legacy') {
    cache[cacheKey] = source.itemNameId;
    await saveData(STORAGE_KEYS.STEAM_NAME_IDS, cache);
  }
  return source;
}

async function fetchSteamOrderBook(appid, marketHashName, signal) {
  const source = await getSteamOrderBookSource(appid, marketHashName, signal);
  if (source.kind === 'orderbook') return { data: source.data, itemNameId: null, source: 'steam-ssr-cny' };
  const itemNameId = source.itemNameId;
  const listingUrl = buildSteamListingUrl(appid, marketHashName);
  const params = new URLSearchParams({
    country: STEAM_COUNTRY,
    language: STEAM_LANGUAGE,
    currency: String(STEAM_CURRENCY_CNY),
    item_nameid: String(itemNameId),
    two_factor: '0',
    norender: '1'
  });
  const url = `https://steamcommunity.com/market/itemordershistogram?${params}`;
  const response = await fetchWithRetry(url, {
    headers: { 'Accept': 'application/json' },
    referrer: listingUrl
  }, { retries: 2, baseDelay: 3000 }, signal);
  if (!response.ok) throw new Error(`Steam orderbook HTTP ${response.status}`);
  const data = await response.json();
  if (!data || !data.success) throw new Error('Steam orderbook response unsuccessful');
  return { data, itemNameId, source: 'steam-order-histogram-cny' };
}

const STALE_HEARTBEAT_MS = 60_000;

async function checkScanHealth() {
  // SW 复活时检查 storage 里的 scanState 是否 stale
  if (isScanning) return { stale: false };
  try {
    const saved = await loadData(STORAGE_KEYS.SCAN_STATE);
    if (!saved || saved.status !== 'running') return { stale: false };
    const heartbeat = saved.heartbeat || saved.startTime || 0;
    const age = Date.now() - heartbeat;
    if (age > STALE_HEARTBEAT_MS) {
      saved.status = 'aborted';
      saved.error = '上次扫描意外中断（SW 被回收）';
      await saveData(STORAGE_KEYS.SCAN_STATE, saved);
      return { stale: true, saved };
    }
    return { stale: false };
  } catch (_) {
    return { stale: false };
  }
}

async function enrichItemsWithSteam(itemIds, { force = false } = {}) {
  if (isEnriching || isScanning) return { ok: false, error: '扫描或行情复核正在进行' };
  isEnriching = true;

  try {
    if (!liveItems.length) {
      const saved = await loadScanResult();
      if (saved?.items?.length) {
        liveItems = saved.items;
        liveScanInfo.game = saved.game || '';
        liveScanInfo.timestamp = saved.timestamp || '';
      }
    }
    if (!itemIds?.length || !liveItems.length) {
      isEnriching = false;
      return { ok: false, error: '没有可更新的扫描结果' };
    }
  } catch (error) { isEnriching = false; throw error; }

  enrichAbortController = new AbortController();
  enrichProgress = { done: 0, total: itemIds.length };
  startKeepAlive();

  const idSet = new Set(itemIds.map(String));
  let enriched = 0;

  try {
    for (let i = 0; i < liveItems.length; i++) {
      const item = liveItems[i];
      if (!idSet.has(String(item.id))) continue;
      if (!force && (item.steamUnsupported || quoteStatus(item) === 'fresh')) {
        enrichProgress.done++;
        continue;
      }
      if (item.steamOrderbookUnsupported && !force) {
        enrichProgress.done++;
        continue;
      }
      if (enrichAbortController.signal.aborted) break;

      const signal = enrichAbortController.signal;
      // Invalidate the old evidence before I/O. Partial failures and cancellation
      // must never combine a new quote with old volume or old orderbook data.
      Object.assign(item, {
        steamVerifiedAt: null, steamAttemptedAt: Date.now(), steamEnrichError: '',
        steamOrderbookAvailable: false, steamOrderbookError: '',
        steamBuyOrderPrice: 0, steamQuickSellNetCny: 0, quickSellCostRate: null,
        quickSellReturnMultiple: null, steamVolume: null, steamSellCount: null,
        liquidityDays: null
      });
      const [priceResult, searchResult] = await Promise.allSettled([
        fetchSteamPriceOverview(item.appid, item.marketHashName, signal),
        fetchSteamSearchRender(item.appid, item.marketHashName, signal)
      ]);
      const priceData = priceResult.status === 'fulfilled' ? priceResult.value : null;
      const searchData = searchResult.status === 'fulfilled' ? searchResult.value : null;
      const errors = [priceResult, searchResult]
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (!priceData?.success && priceResult.status === 'fulfilled') errors.push(new Error('Steam 成交量接口未返回有效数据'));

      if (priceData?.success) {
        const steamPrice = parseSteamPrice(priceData.lowest_price);
        if (steamPrice > 0) {
          item.steamPriceCny = steamPrice;
          item.afterTaxPrice = getSteamNetPrice(steamPrice);
          item.sellRatio = calcCostRate(item.buffSellMinPrice, steamPrice);
          item.listingCostRate = item.sellRatio;
          item.returnMultiple = calcReturnMultiple(item.buffSellMinPrice, steamPrice);
        }
        const volume = Number(String(priceData.volume ?? '').replace(/,/g, ''));
        item.steamVolume = priceData.volume !== undefined && Number.isSafeInteger(volume) && volume >= 0 ? volume : null;
      }

      if (searchData) {
        const count = Number(searchData.sell_listings);
        item.steamSellCount = searchData.sell_listings !== null && searchData.sell_listings !== undefined
          && Number.isSafeInteger(count) && count >= 0 ? count : null;
      }
      item.liquidityDays = calcLiquidityDays(item.steamSellCount, item.steamVolume);

      if (!signal.aborted) {
        if (force) item.steamOrderbookUnsupported = false;
        try {
          const orderBook = await fetchSteamOrderBook(item.appid, item.marketHashName, signal);
          const histogram = orderBook.data;
          item.steamNameId = orderBook.itemNameId;
          item.steamOrderbookSource = orderBook.source;
          const exactSellCount = parseSteamOrderCount(histogram.sellOrderCount ?? histogram.sell_order_count ?? histogram.sell_order_summary);
          if (exactSellCount !== null) {
            // The verified item's own orderbook is a stronger source than a
            // fuzzy search page, which Steam can truncate despite count=100.
            item.steamSellCount = exactSellCount;
            item.steamLiquiditySource = 'orderbook';
            if (searchResult.status === 'rejected') {
              const index = errors.indexOf(searchResult.reason);
              if (index !== -1) errors.splice(index, 1);
            }
          } else item.steamLiquiditySource = searchData ? 'search' : null;
          item.steamBuyOrderPrice = parseSteamOrderPrice(histogram.highest_buy_order);
          item.steamOrderbookLowestSellPrice = parseSteamOrderPrice(histogram.lowest_sell_order);
          item.steamBuyCount = parseSteamOrderCount(histogram.buy_order_count ?? histogram.buy_order_summary) ?? 0;
          item.steamOrderbookAvailable = item.steamBuyOrderPrice > 0;
          item.quickSellCostRate = calcCostRate(item.buffSellMinPrice, item.steamBuyOrderPrice);
          item.quickSellReturnMultiple = calcReturnMultiple(item.buffSellMinPrice, item.steamBuyOrderPrice);
          item.steamQuickSellNetCny = getSteamNetPrice(item.steamBuyOrderPrice);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          item.steamOrderbookError = error?.message || 'orderbook unavailable';
          // Steam may not expose item_nameid in the listing HTML; avoid repeating an
          // unaddressable orderbook request unless the user explicitly forces a retry.
          item.steamOrderbookUnsupported = /item_nameid not found/i.test(item.steamOrderbookError);
          errors.push(error);
        }
      }

      item.liquidityDays = calcLiquidityDays(item.steamSellCount, item.steamVolume);
      const success = Boolean(priceData?.success || searchData || item.steamOrderbookAvailable);
      const permanentMissing = errors.some(error => classifyError(error) === 'not_found');
      item.steamUnsupported = !success && permanentMissing;
      item.steamEnriched = success;
      item.enrichedAt = success ? Date.now() : item.enrichedAt;
      item.steamEnrichError = errors.map(error => error?.message || String(error)).join('；');
      if (signal.aborted) item.steamEnrichError = '复核已取消，请重新复核';
      if (!item.steamEnrichError && item.steamOrderbookAvailable && item.liquidityDays !== null) item.steamVerifiedAt = Date.now();
      if (success) enriched++;
      else if (item.steamUnsupported) liveStats.enrichSkipped = (liveStats.enrichSkipped || 0) + 1;
      else if (errors.length) {
        liveStats.enrichFailed = (liveStats.enrichFailed || 0) + 1;
        const error = errors[0];
        console.warn(`Steam enrich partial/failure (${classifyError(error)}) for ${item.name}: ${error.message}`);
      }

      enrichProgress.done++;
      if (enrichProgress.done % 5 === 0) await saveCurrentScanResult();
      await sleep(STEAM_REQUEST_INTERVAL, signal);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') console.error('Steam enrichment stopped:', error);
  } finally {
    liveStats.profitableItems = liveItems.filter(item => isOpportunityCandidate(item)).length;
    await saveCurrentScanResult();
    isEnriching = false;
    enrichAbortController = null;
    stopKeepAlive();
  }

  return { ok: true, enriched };
}

async function saveCurrentScanResult() {
  try {
    await saveScanResult({
      timestamp: new Date().toISOString(),
      game: liveScanInfo.game,
      scanMode: liveScanInfo.scanMode || 'all',
      items: liveItems,
      stats: { ...liveStats }
    });
  } catch (error) {
    console.error('Save after scan/enrich failed:', error);
    if (isQuotaError(error)) markQuotaExceeded();
  }
}

// Desktop history has already committed the restored snapshot atomically.
// Called only by the trusted host while the scan/enrichment engine is idle.
function adoptScanSnapshot(result) {
  liveItems = result.items;
  liveStats = { ...result.stats, scannedItems: liveItems.length };
  liveScanInfo = { game: result.game, scanMode: result.scanMode, timestamp: result.timestamp, startTime: 0, page: 0, totalPages: 0 };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startScan') {
    if (isScanning || isEnriching) {
      sendResponse({ ok: false, error: '扫描或行情复核正在进行' });
      return true;
    }
    // Reply immediately: the popup needs to start polling while the scan runs.
    // Keeping sendResponse open until all pages finish made the UI appear frozen.
    startScan(request.game, request.scanMode || 'all').catch(e => {
      console.error('Scan failed:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (request.action === 'stopScan') {
    if (scanAbortController) scanAbortController.abort();
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'getLiveItems') {
    loadData(STORAGE_KEYS.SCAN_STATE).then(scanState => sendResponse({
      ok: true,
      isScanning: isScanning,
      items: liveItems,
      stats: liveStats,
      scanInfo: liveScanInfo,
      scanState,
      isEnriching: isEnriching,
      enrichProgress: enrichProgress
    })).catch(() => sendResponse({
      ok: true, isScanning, items: liveItems, stats: liveStats, scanInfo: liveScanInfo,
      scanState: null, isEnriching, enrichProgress
    }));
    return true;
  }

  if (request.action === 'enrichSteam') {
    if (isEnriching) {
      sendResponse({ ok: false, error: 'Already enriching' });
      return true;
    }
    // Acknowledge immediately so the popup can poll progress and offer cancellation.
    enrichItemsWithSteam(request.itemIds || [], { force: Boolean(request.force) })
      .catch(e => console.error('Steam enrichment failed:', e));
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (request.action === 'stopEnrich') {
    if (enrichAbortController) enrichAbortController.abort();
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'checkScanHealth') {
    checkScanHealth().then(result => sendResponse({ ok: true, ...result }));
    return true;
  }

  if (request.action === 'getScanResult') {
    loadScanResult().then(result => sendResponse({ ok: true, result }));
    return true;
  }
});
