let allItems = [];
let filteredItems = [];
let currentPage = 1;
const PAGE_SIZE = 100;
let pollTimer = null;
let isEnriching = false;

const $ = (id) => document.getElementById(id);
function numberInput(id, fallback) {
  const raw = $(id).value.trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      const error = chrome.runtime.lastError;
      resolve(response || { ok: false, error: error?.message || '后台暂不可用' });
    });
  });
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `¥${number.toFixed(2)}` : '—';
}
function formatRate(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)} (${(Number(value) * 100).toFixed(0)}%)` : '—';
}
function formatDays(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} 天` : '—';
}
function formatRelativeTime(value) {
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(time) || time <= 0) return '—';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
function rateClass(value) {
  if (value === null || value === undefined) return 'ratio-bad';
  if (value <= numberInput('ratioFilter', DEFAULT_COST_RATE)) return 'ratio-good';
  if (value <= 0.85) return 'ratio-ok';
  return 'ratio-bad';
}
function selectedCandidate(item) {
  return isOpportunityCandidate(item, {
    maxCostRate: numberInput('ratioFilter', DEFAULT_COST_RATE),
    maxLiquidityDays: numberInput('maxLiquidityDays', DEFAULT_LIQUIDITY_DAYS)
  });
}
function updateOverview(stats = {}) {
  $('ovTotal').textContent = (Number(stats.scannedItems) || allItems.length || 0).toLocaleString();
  $('ovAvgRatio').textContent = allItems.filter(selectedCandidate).length.toLocaleString();
  const best = allItems
    .map(item => item.quickSellCostRate)
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b)[0];
  $('ovBestRatio').textContent = best === undefined ? '—' : formatRate(best);
}

function applyFilters() {
  renderReviewStatus(allItems);
  const keyword = $('searchInput').value;
  const maxCostRate = numberInput('ratioFilter', Infinity);
  const maxDays = numberInput('maxLiquidityDays', Infinity);
  const minPrice = Number($('minPrice').value) || 0;
  const maxPrice = numberInput('maxPrice', Infinity);
  const minBuffSellNum = Number($('minBuffSellNum').value) || 0;
  const minSteamVolume = Number($('minSteamVolume').value) || 0;
  const gameFilter = $('gameFilter').value;
  const candidateOnly = $('candidateFilter').checked;

  filteredItems = allItems.filter(item => {
    if (!matchesItemSearch(item, keyword)) return false;
    if (gameFilter !== 'all' && item.game !== gameFilter) return false;
    const cost = Number(item.buffSellMinPrice) || 0;
    if (cost < minPrice || cost > maxPrice) return false;
    if ((Number(item.buffSellNum) || 0) < minBuffSellNum) return false;
    if ((Number(item.steamVolume) || 0) < minSteamVolume) return false;
    if (candidateOnly) return selectedCandidate(item);
    const rate = item.quickSellCostRate ?? item.listingCostRate ?? item.sellRatio;
    if (rate !== null && rate !== undefined && Number.isFinite(maxCostRate) && rate > maxCostRate) return false;
    if (item.liquidityDays !== null && item.liquidityDays !== undefined && Number.isFinite(maxDays) && item.liquidityDays > maxDays) return false;
    return true;
  });
  const showingPending = candidateOnly && isEnriching && filteredItems.length === 0;
  if (showingPending) {
    filteredItems = getPendingOpportunityItems(allItems, { maxCostRate, limit: STEAM_ENRICH_BATCH_SIZE })
      .filter(item => matchesItemSearch(item, keyword)
        && (gameFilter === 'all' || item.game === gameFilter)
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
    const value = item => {
      switch (sortBy) {
        case 'quickSellCostRate': return item.quickSellCostRate ?? Infinity;
        case 'liquidityDays': return item.liquidityDays ?? Infinity;
        case 'steamVolume': return item.steamVolume ?? Infinity;
        case 'buffSellMinPrice': return Number(item.buffSellMinPrice) || 0;
        case 'sellRatio': return item.listingCostRate ?? item.sellRatio ?? Infinity;
        default: return item.quickSellCostRate ?? item.sellRatio ?? Infinity;
      }
    };
    const av = value(a), bv = value(b);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return Number.isFinite(av) ? -1 : Number.isFinite(bv) ? 1 : 0;
    return (av - bv) * order || compareOpportunity(a, b);
  });
  currentPage = 1;
  $('resultCount').textContent = showingPending
    ? `0 件已达标 · 显示 ${filteredItems.length} 件待复核`
    : `${filteredItems.length.toLocaleString()} 件${candidateOnly ? '达标候选' : '结果'}`;
  renderTable();
  renderPagination();
  updateOverview();
}

function renderTable() {
  const tbody = $('tableBody');
  clearChildren(tbody);
  const pageItems = filteredItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  if (!pageItems.length) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: '16', class: 'empty-msg', text: isEnriching
      ? 'Steam 行情复核中，达标候选会逐步出现…'
      : '没有符合条件的物品；可取消“只看达标候选”或放宽筛选。' })));
    return;
  }

  pageItems.forEach((item, index) => {
    const listingRate = item.listingCostRate ?? item.sellRatio;
    const quickRate = item.quickSellCostRate;
    const candidate = selectedCandidate(item);
    const gameLabel = item.game === 'csgo' ? 'CS2' : 'DOTA2';
    const age = ({ fresh: '已复核', stale: '已过期', error: '复核失败', partial: '未完整复核', pending: '待复核', unsupported: '不可用' })[quoteStatus(item)];
    const buffUrl = `https://buff.163.com/goods/${encodeURIComponent(item.id)}`;
    const steamUrl = safeUrl(item.steamMarketUrl) || (item.appid && item.marketHashName
      ? `https://steamcommunity.com/market/listings/${item.appid}/${encodeURIComponent(item.marketHashName)}`
      : '');
    const walletDelta = Number(item.steamQuickSellNetCny) - Number(item.buffSellMinPrice);
    const row = el('tr', { class: candidate ? 'profitable-row' : '' },
      el('td', { class: 'col-rank', text: String((currentPage - 1) * PAGE_SIZE + index + 1) }),
      el('td', { class: 'item-name-cell', title: item.marketHashName || item.name, text: item.shortName || item.name || '未命名' }),
      el('td', { text: gameLabel }),
      el('td', { class: 'col-price', text: formatPrice(item.buffSellMinPrice) }),
      el('td', { class: 'col-num', text: String(Number(item.buffSellNum) || 0) }),
      el('td', { class: 'col-price', text: formatPrice(item.steamPriceCny) }),
      el('td', { class: 'col-price', text: formatPrice(item.afterTaxPrice) }),
      el('td', { class: 'col-ratio', text: formatRate(listingRate) }),
      el('td', { class: 'col-price', text: formatPrice(item.steamBuyOrderPrice) }),
      el('td', { class: 'col-price', text: formatPrice(item.steamQuickSellNetCny) }),
      el('td', { class: 'col-ratio', text: formatRate(quickRate) }),
      el('td', { class: 'col-num', text: String(item.steamVolume ?? '—') }),
      el('td', { class: 'col-num', text: String(item.steamSellCount ?? '—') }),
      el('td', { class: 'col-num', text: formatDays(item.liquidityDays) }),
      el('td', { class: 'col-num', title: item.steamOrderbookError || '', text: age }),
      el('td', { class: 'col-action' },
        el('a', { href: buffUrl, target: '_blank', rel: 'noreferrer', class: 'action-link', text: 'BUFF' }),
        steamUrl && el('a', { href: steamUrl, target: '_blank', rel: 'noreferrer', class: 'action-link', style: { marginLeft: '6px' }, text: 'Steam' })
      )
    );
    row.title = candidate ? `达标：成本率 ${formatRate(quickRate)}；供给覆盖约 ${formatDays(item.liquidityDays)}`
      : `快速卖出净到账减 BUFF 成本：${formatPrice(walletDelta)}；结果仅为估算`;
    tbody.appendChild(row);
  });
}

function renderPagination() {
  const pag = $('pagination');
  clearChildren(pag);
  const pages = Math.ceil(filteredItems.length / PAGE_SIZE);
  if (pages <= 1) return;
  const add = (label, page, active = false) => pag.appendChild(el('button', {
    class: active ? 'active' : '', text: label,
    onClick: () => { currentPage = page; renderTable(); renderPagination(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }));
  if (currentPage > 1) add('◀ 上一页', currentPage - 1);
  for (let page = Math.max(1, currentPage - 3); page <= Math.min(pages, currentPage + 3); page++) add(String(page), page, page === currentPage);
  if (currentPage < pages) add('下一页 ▶', currentPage + 1);
}

function escapeCSVCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function exportCSV() {
  if (!filteredItems.length) return;
  const headers = ['排名','名称','游戏','BUFF买入成本','BUFF在售','Steam最低挂单','挂单净到账估算','挂单成本率','Steam最高求购','快速净到账估算','快速成本率','近24小时成交量','Steam在售数','供给覆盖天数','行情更新时间','BUFF链接','Steam链接'];
  const rows = filteredItems.map((item, index) => [
    index + 1, item.name, item.game === 'csgo' ? 'CS2' : 'DOTA2', item.buffSellMinPrice,
    item.buffSellNum, item.steamPriceCny, item.afterTaxPrice, item.listingCostRate ?? item.sellRatio,
    item.steamBuyOrderPrice, item.steamQuickSellNetCny, item.quickSellCostRate, item.steamVolume,
    item.steamSellCount, item.liquidityDays, item.enrichedAt ? new Date(item.enrichedAt).toISOString() : '',
    `https://buff.163.com/goods/${item.id}`, item.steamMarketUrl || ''
  ].map(escapeCSVCell).join(','));
  downloadFile(`steam_and_buff·倒余额-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + [headers, ...rows].map(row => Array.isArray(row) ? row.map(escapeCSVCell).join(',') : row).join('\n'), 'text/csv;charset=utf-8');
}
function exportJSON() {
  if (!filteredItems.length) return;
  downloadFile(`steam_and_buff·倒余额-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(filteredItems, null, 2), 'application/json');
}
function downloadFile(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ensurePolling() { if (!pollTimer) pollTimer = setInterval(pollLiveItems, 1500); }
async function pollLiveItems() {
  const response = await sendMsg({ action: 'getLiveItems' });
  if (!response.ok) return;
  allItems = response.items || [];
  isEnriching = Boolean(response.isEnriching);
  applyFilters();
  $('btnEnrichSteam').textContent = isEnriching ? '取消 Steam 复核' : '补查 Steam 行情';
  if (isEnriching) {
    const progress = response.enrichProgress || {};
    $('ovScanTime').textContent = `行情复核 ${progress.done || 0}/${progress.total || 0}`;
  } else if (response.scanInfo?.timestamp) {
    $('ovScanTime').textContent = formatRelativeTime(response.scanInfo.timestamp);
  }
  if (!isEnriching && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function loadData() {
  let scanTimestamp = '';
  const response = await sendMsg({ action: 'getLiveItems' });
  if (response.ok && response.items?.length) {
    allItems = response.items;
    isEnriching = Boolean(response.isEnriching);
    scanTimestamp = response.scanInfo?.timestamp || '';
    updateOverview(response.stats || {});
    if (isEnriching) ensurePolling();
  } else {
    const saved = await sendMsg({ action: 'getScanResult' });
    if (saved.ok && saved.result?.items?.length) {
      allItems = saved.result.items;
      scanTimestamp = saved.result.timestamp || '';
      updateOverview(saved.result.stats || {});
    }
  }
  applyFilters();
  $('ovScanTime').textContent = scanTimestamp ? formatRelativeTime(scanTimestamp) : '—';
}
$('btnRefresh').addEventListener('click', loadData);
$('btnExportCSV').addEventListener('click', exportCSV);
$('btnExportJSON').addEventListener('click', exportJSON);
$('btnEnrichSteam').addEventListener('click', async () => {
  if (isEnriching) {
    await sendMsg({ action: 'stopEnrich' });
    return;
  }
  const selection = (filteredItems.length ? filteredItems : allItems)
    .filter(item => quoteStatus(item) !== 'fresh' && !item.steamUnsupported)
    .sort((a, b) => (a.steamAttemptedAt || 0) - (b.steamAttemptedAt || 0) || compareOpportunity(a, b))
    .slice(0, STEAM_ENRICH_BATCH_SIZE);
  if (!selection.length) return;
  $('btnEnrichSteam').disabled = true;
  const result = await sendMsg({ action: 'enrichSteam', itemIds: selection.map(item => item.id), force: true });
  $('btnEnrichSteam').disabled = false;
  if (result.ok) { isEnriching = true; ensurePolling(); }
  else $('btnEnrichSteam').textContent = result.error || '启动失败';
});

const FILTER_IDS = ['candidateFilter','ratioFilter','maxLiquidityDays','minPrice','maxPrice','minBuffSellNum','minSteamVolume','gameFilter','sortBy','sortOrder'];
function saveFilters() {
  const data = {};
  for (const id of FILTER_IDS) data[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  chrome.storage.local.set({ dashboardFilters: data });
}
function restoreFilters() {
  return new Promise(resolve => chrome.storage.local.get('dashboardFilters', result => {
    const data = result.dashboardFilters || {};
    if (data.ratioFilter === '0.95' || data.ratioFilter === 0.95) data.ratioFilter = String(DEFAULT_COST_RATE);
    for (const id of FILTER_IDS) {
      if (data[id] === undefined) continue;
      if ($(id).type === 'checkbox') $(id).checked = Boolean(data[id]);
      else $(id).value = data[id];
    }
    resolve();
  }));
}
function applyAndSave() { applyFilters(); saveFilters(); }
$('searchInput').addEventListener('input', applyAndSave);
for (const id of FILTER_IDS) $(id).addEventListener('input', applyAndSave);

(async function init() {
  await restoreFilters();
  await loadData();
})();
