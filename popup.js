let allItems = [];
let filteredItems = [];
let currentPage = 1;
const PAGE_SIZE = 35;
let isScanning = false;
let isEnriching = false;
let pollTimer = null;

const $ = (id) => document.getElementById(id);
function numberInput(id, fallback) {
  const raw = $(id).value.trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const error = chrome.runtime.lastError;
      resolve(resp || { ok: false, error: error?.message || '后台暂不可用' });
    });
  });
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(2) : '—';
}

function formatRate(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)}（${(Number(value) * 100).toFixed(0)}%）` : '—';
}

function getRateClass(value) {
  if (value === null || value === undefined) return 'ratio-bad';
  if (value <= numberInput('ratioFilter', DEFAULT_COST_RATE)) return 'ratio-good';
  if (value <= 0.85) return 'ratio-ok';
  return 'ratio-bad';
}

function renderItems() {
  const list = $('itemList');
  clearChildren(list);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredItems.slice(start, start + PAGE_SIZE);

  if (pageItems.length === 0) {
    let emptyText = allItems.length
      ? '没有符合当前条件的物品。可取消“只看达标候选”、放宽筛选，或等待 Steam 行情复核完成。'
      : '点击「扫描并筛选」获取 BUFF 饰品并自动复核候选。';
    if (isEnriching && allItems.length) emptyText = 'Steam 行情复核中，达标候选会逐步显示…';
    list.appendChild(el('div', { class: 'empty-state', text: emptyText }));
    $('pagination').style.display = 'none';
    return;
  }

  for (const item of pageItems) {
    const listingRate = item.listingCostRate ?? item.sellRatio;
    const quickRate = item.quickSellCostRate;
    const candidate = isOpportunityCandidate(item, {
      maxCostRate: numberInput('ratioFilter', DEFAULT_COST_RATE),
      maxLiquidityDays: numberInput('maxLiquidityDays', DEFAULT_LIQUIDITY_DAYS)
    });
    const ageText = item.enrichedAt ? formatRelativeTime(item.enrichedAt) : '';
    const marketUrl = safeUrl(item.steamMarketUrl) || (item.appid && item.marketHashName
      ? `https://steamcommunity.com/market/listings/${item.appid}/${encodeURIComponent(item.marketHashName)}`
      : '');

    const card = el('article', { class: `item-card ${candidate ? 'profitable' : ''}` },
      el('div', { class: 'item-info' },
        el('div', { class: 'item-heading' },
          el('div', { class: 'item-name', title: item.marketHashName || item.name, text: item.shortName || item.name || '未命名物品' }),
          candidate && el('span', { class: 'candidate-badge', text: '达标' })
        ),
        el('div', { class: 'item-prices' },
          el('span', { class: 'price-buff', text: `BUFF买入 ¥${formatPrice(item.buffSellMinPrice)} · 在售 ${Number(item.buffSellNum) || 0}` }),
          el('span', { class: 'price-steam', text: `Steam挂单 ¥${formatPrice(item.steamPriceCny)} → 净到 ¥${formatPrice(item.afterTaxPrice)}` }),
          el('span', { class: 'ratio-chip', text: `挂单成本率 ${formatRate(listingRate)}` })
        ),
        el('div', { class: 'item-prices' },
          el('span', { class: 'price-steam', text: item.steamOrderbookAvailable
            ? `Steam快速卖 ¥${formatPrice(item.steamBuyOrderPrice)} → 净到 ¥${formatPrice(item.steamQuickSellNetCny)}`
            : (item.steamOrderbookUnsupported ? 'Steam求购盘：当前不可读' : 'Steam求购盘：待复核') }),
          el('span', { class: 'ratio-chip', text: `快速成本率 ${formatRate(quickRate)}` }),
          el('span', { class: 'liquidity-chip', text: `近24h ${item.steamVolume ?? '—'} 笔 · 在售 ${item.steamSellCount ?? '—'} · 供给覆盖 ${!Number.isFinite(item.liquidityDays) ? '—' : `${item.liquidityDays.toFixed(1)}天`}` })
        ),
        el('div', { class: 'item-foot' },
          el('span', { class: 'freshness', title: item.steamOrderbookError || '', text: ageText ? `Steam 更新于 ${ageText}` : (item.steamOrderbookError ? `求购盘${item.steamOrderbookUnsupported ? '无法读取' : '暂不可用'}，挂单价仅作初筛` : 'Steam 实时报价尚未核实') }),
          marketUrl && el('a', { class: 'market-link', href: marketUrl, target: '_blank', rel: 'noreferrer', text: '打开 Steam ↗', onClick: (event) => event.stopPropagation() })
        )
      )
    );
    list.appendChild(card);
  }
  renderPagination();
}

function renderPagination() {
  const totalPages = Math.ceil(filteredItems.length / PAGE_SIZE);
  const pag = $('pagination');
  clearChildren(pag);
  if (totalPages <= 1) {
    pag.style.display = 'none';
    return;
  }
  pag.style.display = 'flex';
  const button = (label, page, active = false) => el('button', {
    class: active ? 'active' : '', text: label,
    onClick: () => { currentPage = page; renderItems(); }
  });
  if (currentPage > 1) pag.appendChild(button('◀', currentPage - 1));
  const first = Math.max(1, currentPage - 2);
  const last = Math.min(totalPages, currentPage + 2);
  for (let page = first; page <= last; page++) pag.appendChild(button(String(page), page, page === currentPage));
  if (currentPage < totalPages) pag.appendChild(button('▶', currentPage + 1));
}

function applyFilters() {
  renderReviewStatus(allItems);
  const keyword = $('searchInput').value;
  const maxCostRate = numberInput('ratioFilter', Infinity);
  const maxDays = numberInput('maxLiquidityDays', Infinity);
  const minPrice = Number($('minPriceFilter').value) || 0;
  const maxPrice = numberInput('maxPriceFilter', Infinity);
  const minBuffSellNum = Number($('minBuffSellNum').value) || 0;
  const minSteamVolume = Number($('minSteamVolume').value) || 0;
  const candidateOnly = $('candidateFilter').checked;

  filteredItems = allItems.filter(item => {
    if (!matchesItemSearch(item, keyword)) return false;
    const cost = Number(item.buffSellMinPrice) || 0;
    if (cost < minPrice || cost > maxPrice) return false;
    if ((Number(item.buffSellNum) || 0) < minBuffSellNum) return false;
    if ((Number(item.steamVolume) || 0) < minSteamVolume) return false;
    if (candidateOnly && !isOpportunityCandidate(item, { maxCostRate, maxLiquidityDays: maxDays })) return false;
    if (!candidateOnly) {
      const rate = item.quickSellCostRate ?? item.listingCostRate ?? item.sellRatio;
      if (rate !== null && rate !== undefined && Number.isFinite(maxCostRate) && rate > maxCostRate) return false;
      if (item.liquidityDays !== null && item.liquidityDays !== undefined && Number.isFinite(maxDays) && item.liquidityDays > maxDays) return false;
    }
    return true;
  });
  const showingPending = candidateOnly && isEnriching && filteredItems.length === 0;
  if (showingPending) {
    filteredItems = getPendingOpportunityItems(allItems, { maxCostRate, limit: STEAM_ENRICH_BATCH_SIZE })
      .filter(item => matchesItemSearch(item, keyword)
        && (Number(item.buffSellMinPrice) || 0) >= minPrice
        && (Number(item.buffSellMinPrice) || 0) <= maxPrice
        && (Number(item.buffSellNum) || 0) >= minBuffSellNum
        && (Number(item.steamVolume) || 0) >= minSteamVolume);
  }

  const sortBy = $('sortBy').value;
  const order = $('sortOrder').value === 'desc' ? -1 : 1;
  const query = $('searchInput').value;
  filteredItems.sort((a, b) => {
    const searchOrder = rankItemSearch(a, query) - rankItemSearch(b, query);
    if (searchOrder) return searchOrder;
    if (sortBy === 'opportunity') return compareOpportunity(a, b);
    const get = (item) => {
      switch (sortBy) {
        case 'quickSellCostRate': return item.quickSellCostRate ?? Infinity;
        case 'liquidityDays': return item.liquidityDays ?? Infinity;
        case 'steamVolume': return item.steamVolume ?? Infinity;
        case 'buffSellMinPrice': return Number(item.buffSellMinPrice) || 0;
        case 'sellRatio': return item.listingCostRate ?? item.sellRatio ?? Infinity;
        default: return item.quickSellCostRate ?? item.sellRatio ?? Infinity;
      }
    };
    const av = get(a), bv = get(b);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return Number.isFinite(av) ? -1 : Number.isFinite(bv) ? 1 : 0;
    return (av - bv) * order || compareOpportunity(a, b);
  });
  currentPage = 1;
  $('resultCount').textContent = showingPending
    ? `0 件已达标 · 显示 ${filteredItems.length} 件待复核`
    : `${filteredItems.length} 件${candidateOnly ? '达标候选' : '结果'}`;
  renderItems();
}

function formatRelativeTime(value) {
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(time) || time <= 0) return '';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function updateStats(stats, totalItems, scanTimestamp) {
  $('statsBar').style.display = 'flex';
  $('statTotal').textContent = `扫描 ${Number(stats.scannedItems) || totalItems || 0} 件`;
  const candidates = allItems.filter(item => isOpportunityCandidate(item, {
    maxCostRate: numberInput('ratioFilter', DEFAULT_COST_RATE),
    maxLiquidityDays: numberInput('maxLiquidityDays', DEFAULT_LIQUIDITY_DAYS)
  })).length;
  $('statCandidates').textContent = `达标 ${candidates} 件`;
  const timeEl = $('statTime');
  if (timeEl && scanTimestamp) {
    const rel = formatRelativeTime(scanTimestamp);
    const time = typeof scanTimestamp === 'number' ? scanTimestamp : new Date(scanTimestamp).getTime();
    const stale = Date.now() - time > 15 * 60_000;
    timeEl.textContent = stale ? `⚠ ${rel}` : rel;
    timeEl.style.color = stale ? '#b54708' : '#667085';
  }
}

function setScanningUI(scanning) {
  isScanning = scanning;
  $('btnStartScan').disabled = scanning;
  $('btnStopScan').disabled = !scanning;
  $('progressContainer').style.display = scanning ? 'block' : 'none';
}

function ensurePolling() {
  if (!pollTimer) pollTimer = setInterval(pollLiveItems, 1200);
}

async function pollLiveItems() {
  const resp = await sendMsg({ action: 'getLiveItems' });
  if (!resp.ok) return;
  allItems = resp.items || [];
  setScanningUI(Boolean(resp.isScanning));
  isEnriching = Boolean(resp.isEnriching);
  updateStats(resp.stats || {}, allItems.length, (resp.scanInfo || {}).timestamp);
  applyFilters();

  if (isScanning) {
    const stats = resp.stats || {};
    const info = resp.scanInfo || {};
    const pct = stats.totalItems > 0 ? Math.min(100, stats.scannedItems / stats.totalItems * 100) : 0;
    $('progressBar').style.width = `${pct}%`;
    $('progressText').textContent = `${stats.scannedItems || 0} / ${stats.totalItems || 0} (${pct.toFixed(1)}%)`;
    $('scanStatus').textContent = `扫描第 ${info.page || '?'} 页；已收集 ${stats.scannedItems || 0} 件`;
    $('scanStatus').style.color = '#3157c8';
  } else if (isEnriching) {
    const progress = resp.enrichProgress || {};
    $('progressContainer').style.display = 'block';
    const pct = progress.total ? Math.min(100, progress.done / progress.total * 100) : 0;
    $('progressBar').style.width = `${pct}%`;
    $('progressText').textContent = `Steam 行情复核 ${progress.done || 0} / ${progress.total || 0}`;
    $('scanStatus').textContent = `Steam 正在复核排名靠前的候选；未复核数据不会被当作快速卖出报价。`;
    $('scanStatus').style.color = '#3157c8';
  } else {
    $('progressContainer').style.display = 'none';
    if (resp.scanState?.status === 'error') {
      $('scanStatus').textContent = `扫描失败：${resp.scanState.error || '未知错误'}`;
      $('scanStatus').style.color = '#b42318';
    } else if (resp.scanState?.status === 'cancelled' && !allItems.length) {
      $('scanStatus').textContent = '扫描已停止';
      $('scanStatus').style.color = '#667085';
    } else if (allItems.length) {
      const candidateCount = allItems.filter(item => isOpportunityCandidate(item, {
        maxCostRate: numberInput('ratioFilter', DEFAULT_COST_RATE),
        maxLiquidityDays: numberInput('maxLiquidityDays', DEFAULT_LIQUIDITY_DAYS)
      })).length;
      $('scanStatus').textContent = `完成：${allItems.length} 件；当前条件下 ${candidateCount} 件达标。金额为预估，成交速度不作保证。`;
      $('scanStatus').style.color = '#2d6a4f';
    }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  $('btnStartScan').disabled = isScanning || isEnriching;
  $('btnEnrichSteam').textContent = isEnriching ? '取消 Steam 复核' : '补查 Steam';
  $('btnEnrichSteam').disabled = false;
  if (isScanning) $('btnEnrichSteam').disabled = true;
  renderItems();
}

async function loadSavedResults() {
  const live = await sendMsg({ action: 'getLiveItems' });
  if (live.ok && live.items?.length) {
    allItems = live.items;
    setScanningUI(Boolean(live.isScanning));
    isEnriching = Boolean(live.isEnriching);
    updateStats(live.stats || {}, allItems.length, (live.scanInfo || {}).timestamp);
    if (isScanning || isEnriching) ensurePolling();
    applyFilters();
    return;
  }
  const saved = await sendMsg({ action: 'getScanResult' });
  if (saved.ok && saved.result?.items?.length) {
    allItems = saved.result.items;
    updateStats(saved.result.stats || {}, allItems.length, saved.result.timestamp);
    applyFilters();
    $('scanStatus').textContent = `已载入上次扫描：${allItems.length} 件`;
  }
}

$('btnStartScan').addEventListener('click', async () => {
  const game = $('gameSelect').value;
  const scanMode = $('scanMode').value;
  allItems = [];
  filteredItems = [];
  renderItems();
  setScanningUI(true);
  $('scanStatus').textContent = '正在启动 BUFF 扫描…';
  $('progressBar').style.width = '0%';
  $('progressText').textContent = '准备中';
  const response = await sendMsg({ action: 'startScan', game, scanMode });
  if (!response.ok) {
    setScanningUI(false);
    $('scanStatus').textContent = `启动失败：${response.error || '未知错误'}`;
    $('scanStatus').style.color = '#b42318';
    return;
  }
  ensurePolling();
  await pollLiveItems();
});

$('btnStopScan').addEventListener('click', async () => {
  await sendMsg({ action: 'stopScan' });
  $('scanStatus').textContent = '正在停止扫描…';
});

$('btnEnrichSteam').addEventListener('click', async () => {
  if (isEnriching) {
    await sendMsg({ action: 'stopEnrich' });
    $('scanStatus').textContent = '正在取消 Steam 复核…';
    return;
  }
  const selection = (filteredItems.length ? filteredItems : allItems)
    .filter(item => quoteStatus(item) !== 'fresh' && !item.steamUnsupported)
    .sort((a, b) => (a.steamAttemptedAt || 0) - (b.steamAttemptedAt || 0) || compareOpportunity(a, b))
    .slice(0, STEAM_ENRICH_BATCH_SIZE);
  if (!selection.length) {
    $('scanStatus').textContent = '当前结果没有待补查项；取消候选过滤可查看更多。';
    return;
  }
  $('btnEnrichSteam').disabled = true;
  $('scanStatus').textContent = `开始复核最多 ${selection.length} 件；Steam 请求会限速执行。`;
  const response = await sendMsg({ action: 'enrichSteam', itemIds: selection.map(item => item.id), force: true });
  if (!response.ok) {
    $('btnEnrichSteam').disabled = false;
    $('scanStatus').textContent = `启动复核失败：${response.error || '未知错误'}`;
    return;
  }
  isEnriching = true;
  ensurePolling();
  await pollLiveItems();
});

$('btnDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

const FILTER_IDS = ['candidateFilter', 'ratioFilter', 'maxLiquidityDays', 'minPriceFilter', 'maxPriceFilter', 'minBuffSellNum', 'minSteamVolume', 'sortBy', 'sortOrder'];
function saveFilters() {
  const data = {};
  for (const id of FILTER_IDS) data[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  chrome.storage.local.set({ popupFilters: data });
}
function restoreFilters() {
  return new Promise(resolve => {
    chrome.storage.local.get('popupFilters', result => {
      const data = result.popupFilters || {};
      if (data.ratioFilter === '0.95' || data.ratioFilter === 0.95) data.ratioFilter = String(DEFAULT_COST_RATE);
      for (const id of FILTER_IDS) {
        if (data[id] === undefined) continue;
        if ($(id).type === 'checkbox') $(id).checked = Boolean(data[id]);
        else $(id).value = data[id];
      }
      resolve();
    });
  });
}
function applyAndSave() { applyFilters(); saveFilters(); }
$('searchInput').addEventListener('input', applyAndSave);
for (const id of FILTER_IDS) $(id).addEventListener('input', applyAndSave);

(async function init() {
  await restoreFilters();
  await loadSavedResults();
})();
