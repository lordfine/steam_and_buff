let allItems = [];
let filteredItems = [];
let currentPage = 1;
const PAGE_SIZE = 100;
let pollTimer = null;
let isEnriching = false;
let favorites = new Set();
let detailKey = null;
let refreshing = false;
const itemKey = item => `${item.game}:${item.id}`;
const QUOTE_LABELS = { fresh: '已完整复核', stale: '行情过期', error: '复核失败', partial: '数据不完整', pending: '未核实', unsupported: '暂不支持' };

const $ = (id) => document.getElementById(id);
function numberInput(id, fallback) {
  const raw = $(id).value.trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function sendMsg(msg) {
  try { return await window.desktop.request(msg); }
  catch (error) { return { ok: false, error: error.message }; }
}
function feedback(message, error = false) {
  $('feedback').textContent = message || '';
  $('feedback').classList.toggle('error', error);
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
  if (value <= numberInput('ratioFilter', Infinity)) return 'ratio-good';
  if (value <= 0.85) return 'ratio-ok';
  return 'ratio-bad';
}
function selectedCandidate(item) {
  return isOpportunityCandidate(item, {
    maxCostRate: numberInput('ratioFilter', Infinity),
    maxLiquidityDays: numberInput('maxLiquidityDays', Infinity)
  });
}
function updateOverview(stats = {}) {
  $('ovTotal').textContent = (Number(stats.scannedItems) || allItems.length || 0).toLocaleString();
  $('ovAvgRatio').textContent = allItems.filter(selectedCandidate).length.toLocaleString();
  const best = allItems
    .filter(item => quoteStatus(item) === 'fresh')
    .map(item => item.quickSellCostRate)
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b)[0];
  $('ovBestRatio').textContent = best === undefined ? '—' : formatRate(best);
}

function applyFilters({ resetPage = true } = {}) {
  const keyword = $('searchInput').value;
  const maxCostRate = numberInput('ratioFilter', Infinity);
  const maxDays = numberInput('maxLiquidityDays', Infinity);
  const minPrice = numberInput('minPrice', 0);
  const maxPrice = numberInput('maxPrice', Infinity);
  const minBuffSellNum = Number($('minBuffSellNum').value) || 0;
  const minSteamVolume = Number($('minSteamVolume').value) || 0;
  const gameFilter = $('gameFilter').value;
  const candidateOnly = $('candidateFilter').checked;
  const invalidRange = minPrice > maxPrice || minPrice < 0 || maxPrice < 0 || maxCostRate < 0 || maxDays < 0;
  $('filterMessage').hidden = !invalidRange;
  $('filterMessage').textContent = invalidRange ? '筛选范围无效：数值不能为负，最低价不能大于最高价。' : '';
  const matchesView = item => {
    if ($('favoritesOnly').checked && !favorites.has(itemKey(item))) return false;
    const status = quoteStatus(item);
    const filter = $('quoteFilter').value;
    return filter === 'all' || (filter === 'needs' ? status !== 'fresh' : status === filter);
  };

  filteredItems = allItems.filter(item => {
    if (invalidRange || !matchesView(item)) return false;
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
  const showingPending = !invalidRange && candidateOnly && isEnriching && filteredItems.length === 0;
  if (showingPending) {
    filteredItems = getPendingOpportunityItems(allItems, { maxCostRate, limit: STEAM_ENRICH_BATCH_SIZE })
      .filter(item => matchesView(item) && matchesItemSearch(item, keyword)
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
    const recommended = () => compareOpportunity(a, b, { maxCostRate, maxLiquidityDays: maxDays });
    if (sortBy === 'opportunity') return recommended();
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
    // Unknown values belong at the bottom in BOTH directions.
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return Number.isFinite(av) ? -1 : Number.isFinite(bv) ? 1 : recommended();
    return (av - bv) * order || recommended();
  });
  currentPage = resetPage ? 1 : Math.min(currentPage, Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE)));
  $('resultCount').textContent = showingPending
    ? `0 件已达标 · 显示 ${filteredItems.length} 件待复核`
    : `${filteredItems.length.toLocaleString()} 件${candidateOnly ? '达标候选' : '结果'}`;
  renderTable();
  renderPagination();
  updateOverview();
  const counts = allItems.reduce((result, item) => { const status = quoteStatus(item); result[status] = (result[status] || 0) + 1; return result; }, {});
  $('quoteSummary').textContent = `已复核 ${counts.fresh || 0} · 已过期 ${counts.stale || 0} · 失败 ${counts.error || 0} · 未完整复核 ${(counts.pending || 0) + (counts.partial || 0) + (counts.unsupported || 0)}`;
  const firstFailure = allItems.find(item => quoteStatus(item) === 'error');
  $('btnFailedReviews').hidden = $('quoteFailureNotice').hidden = !firstFailure;
  $('quoteFailureNotice').textContent = firstFailure
    ? `复核失败原因：${firstFailure.steamEnrichError || firstFailure.steamOrderbookError}。点击「查看失败详情」可重试，不必先放宽候选门槛。` : '';
  $('favoriteCount').textContent = String(favorites.size);
  $('btnExportCSV').disabled = $('btnExportJSON').disabled = !filteredItems.length;
  if ($('detailDialog').open) renderDetail();
}

function renderTable() {
  const tbody = $('tableBody');
  clearChildren(tbody);
  const pageItems = filteredItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  if (!pageItems.length) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: '16', class: 'empty-msg', text: isEnriching
      ? 'Steam 行情复核中，达标候选会逐步出现…'
      : !allItems.length ? '暂无数据，请先登录 BUFF 并点击「扫描并筛选」。也可使用离线演示。'
      : $('favoritesOnly').checked ? '当前结果中没有符合筛选的收藏；点击饰品旁的星标可收藏。'
      : '没有符合条件的物品；可取消“只看达标候选”、查看待处理行情或重置筛选。' })));
    return;
  }

  pageItems.forEach((item, index) => {
    const listingRate = item.listingCostRate ?? item.sellRatio;
    const quickRate = item.quickSellCostRate;
    const candidate = selectedCandidate(item);
    const gameLabel = item.game === 'csgo' ? 'CS2' : 'DOTA2';
    const status = quoteStatus(item);
    const age = item.steamVerifiedAt ? formatRelativeTime(item.steamVerifiedAt) : '—';
    const buffUrl = `https://buff.163.com/goods/${encodeURIComponent(item.id)}`;
    const steamUrl = safeUrl(item.steamMarketUrl) || (item.appid && item.marketHashName
      ? `https://steamcommunity.com/market/listings/${item.appid}/${encodeURIComponent(item.marketHashName)}`
      : '');
    const walletDelta = Number(item.steamQuickSellNetCny) - Number(item.buffSellMinPrice);
    const row = el('tr', { class: candidate ? 'profitable-row' : '' },
      el('td', { class: 'col-rank', text: String((currentPage - 1) * PAGE_SIZE + index + 1) }),
      el('td', { class: 'item-name-cell', title: item.marketHashName || item.name },
        el('button', { class: 'favorite-toggle', 'aria-label': `${favorites.has(itemKey(item)) ? '取消收藏' : '收藏'} ${item.name}`,
          'aria-pressed': String(favorites.has(itemKey(item))), text: favorites.has(itemKey(item)) ? '★' : '☆', onClick: () => toggleFavorite(item) }),
        el('button', { class: 'item-detail-button', text: item.shortName || item.name || '未命名', onClick: () => openDetail(item) })),
      el('td', { text: gameLabel }),
      el('td', { class: 'col-price', text: formatPrice(item.buffSellMinPrice) }),
      el('td', { class: 'col-num', text: String(Number(item.buffSellNum) || 0) }),
      el('td', { class: 'col-price', text: formatPrice(item.steamPriceCny) }),
      el('td', { class: 'col-price', text: formatPrice(item.afterTaxPrice) }),
      el('td', { class: 'col-ratio', text: formatRate(listingRate) }),
      el('td', { class: 'col-price', text: formatPrice(item.steamBuyOrderPrice) }),
      el('td', { class: 'col-price', text: formatPrice(item.steamQuickSellNetCny) }),
      el('td', { class: 'col-ratio', text: formatRate(quickRate) }),
      el('td', { class: 'col-num', text: item.steamVolume === null ? '—' : String(Number(item.steamVolume) || 0) }),
      el('td', { class: 'col-num', text: item.steamSellCount === null ? '—' : String(Number(item.steamSellCount) || 0) }),
      el('td', { class: 'col-num', text: formatDays(item.liquidityDays) }),
      el('td', { class: 'col-num', title: item.steamEnrichError || item.steamOrderbookError || '' },
        el('span', { class: `quote-badge ${status}`, text: QUOTE_LABELS[status] }), el('span', { text: age })),
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

async function toggleFavorite(item) {
  try {
    const result = await window.desktop.setFavorite(itemKey(item), !favorites.has(itemKey(item)));
    if (!result.ok) throw new Error(result.error);
    favorites = new Set(result.keys);
    applyFilters({ resetPage: false });
  } catch (error) { feedback('收藏保存失败：' + error.message, true); }
}
function openDetail(item) {
  detailKey = itemKey(item);
  renderDetail();
  $('detailDialog').showModal();
}
function renderDetail() {
  const item = allItems.find(item => itemKey(item) === detailKey);
  if (!item) { $('detailDialog').close(); return; }
  $('detailTitle').textContent = item.name || '未命名饰品';
  $('detailHash').textContent = `${item.game === 'csgo' ? 'CS2' : 'DOTA2'} · #${item.id} · ${item.marketHashName || ''}`;
  clearChildren($('detailMetrics'));
  for (const [label, value] of [['BUFF 现金成本', formatPrice(item.buffSellMinPrice)], ['Steam 钱包净到账估算', formatPrice(item.steamQuickSellNetCny)], ['快速成本率', formatRate(item.quickSellCostRate)]]) {
    $('detailMetrics').appendChild(el('div', {}, el('small', { text: label }), el('strong', { text: value })));
  }
  const exactTime = value => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录，需重新获取';
  const status = quoteStatus(item);
  const reasons = [];
  if (status !== 'fresh') reasons.push(QUOTE_LABELS[status] + '，不计入达标候选');
  if (item.quickSellCostRate == null) reasons.push('缺少有效 Steam 最高求购价');
  else if (item.quickSellCostRate > numberInput('ratioFilter', Infinity)) reasons.push('快速成本率超过当前阈值');
  if (item.liquidityDays == null) reasons.push('成交量或在售数量不足，无法估计供给覆盖');
  else if (item.liquidityDays > numberInput('maxLiquidityDays', Infinity)) reasons.push('供给覆盖超过当前阈值');
  if (!item.buffFetchedAt || Date.now() - item.buffFetchedAt > QUOTE_MAX_AGE_MS) reasons.push('BUFF 成本已过期 / 未记录：请重新扫描，单独复核 Steam 不会更新 BUFF 成本');
  clearChildren($('detailEvidence'));
  for (const text of [
    selectedCandidate(item) ? '达标候选 · 满足当前成本率、供给覆盖及行情时效条件' : '未达标 · ' + reasons.join('；'),
    `供给覆盖：${formatDays(item.liquidityDays)}（Steam 在售 ÷ 近 24h 成交，仅作粗略参考）`,
    `BUFF 采集时间：${exactTime(item.buffFetchedAt)}`,
    `Steam 完整复核：${exactTime(item.steamVerifiedAt)}`,
    `最近尝试：${exactTime(item.steamAttemptedAt)}`,
    item.steamEnrichError || item.steamOrderbookError ? `错误详情：${item.steamEnrichError || item.steamOrderbookError}` : ''
  ].filter(Boolean)) $('detailEvidence').appendChild(el('p', { text }));
  $('btnDetailFavorite').textContent = favorites.has(detailKey) ? '取消收藏' : '收藏此物品';
  $('btnDetailRefresh').disabled = isScanning || isEnriching || refreshing;
}
async function reviewItems(selection) {
  if (refreshing || isScanning || isEnriching) return;
  if (!selection.length) { feedback('当前筛选没有可复核的物品，请先查看待处理行情或重置筛选。'); return; }
  refreshing = true;
  $('btnEnrichSteam').disabled = true;
  if ($('detailDialog').open) renderDetail();
  try {
    const result = await sendMsg({ action: 'enrichSteam', itemIds: selection.slice(0, STEAM_ENRICH_BATCH_SIZE).map(item => item.id), force: true });
    if (!result.ok) throw new Error(result.error);
    feedback(`已提交 ${Math.min(selection.length, STEAM_ENRICH_BATCH_SIZE)} 件 Steam 复核；不更新 BUFF 成本，每批最多 20 件。`);
    ensurePolling();
  } catch (error) { feedback(error.message, true); }
  finally { refreshing = false; await loadData(); }
}
$('btnCloseDetail').addEventListener('click', () => $('detailDialog').close());
$('btnDetailFavorite').addEventListener('click', () => {
  const item = allItems.find(item => itemKey(item) === detailKey);
  if (item) toggleFavorite(item);
});
$('btnDetailRefresh').addEventListener('click', () => {
  const item = allItems.find(item => itemKey(item) === detailKey);
  if (item) reviewItems([item]);
});
$('btnCloseHistory').addEventListener('click', () => $('historyDialog').close());
$('btnHistory').addEventListener('click', async () => {
  $('historyFeedback').textContent = '';
  clearChildren($('historyList'));
  $('historyList').textContent = '正在读取本地历史…';
  $('historyDialog').showModal();
  const result = await sendMsg({ action: 'listHistory' });
  clearChildren($('historyList'));
  if (!result.ok) { $('historyFeedback').textContent = result.error; return; }
  if (!result.history.length) { $('historyList').textContent = '尚无历史记录。再次扫描前会自动归档当前结果。'; return; }
  for (const entry of result.history) {
    const button = el('button', { class: 'btn btn-outline', text: '恢复此记录', onClick: async () => {
      button.disabled = true;
      const restored = await sendMsg({ action: 'restoreHistory', id: entry.id });
      if (!restored.ok) { $('historyFeedback').textContent = restored.error; button.disabled = false; return; }
      $('historyDialog').close();
      currentPage = 1;
      await loadData();
      feedback('历史结果已恢复；当前结果已保留，行情时间保持原样。');
    } });
    button.disabled = isScanning || isEnriching;
    $('historyList').appendChild(el('div', { class: 'history-entry' }, el('div', {},
      el('strong', { text: `${entry.game === 'csgo' ? 'CS2' : 'DOTA2'} · ${entry.count} 件` }),
      el('small', { text: `${new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false })} · ${entry.scanMode === 'all' ? '全量扫描' : '指定页扫描'}` })), button));
  }
});

function escapeCSVCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function exportCSV() {
  if (!filteredItems.length) { feedback('当前没有可导出的结果。', true); return; }
  const headers = ['排名','名称','游戏','BUFF买入成本','BUFF在售','Steam最低挂单','挂单净到账估算','挂单成本率','Steam最高求购','快速净到账估算','快速成本率','近24h成交量','Steam在售数','供给覆盖天数','行情更新时间','BUFF链接','Steam链接','行情状态','BUFF采集时间','Steam完整复核时间'];
  const rows = filteredItems.map((item, index) => [
    index + 1, item.name, item.game === 'csgo' ? 'CS2' : 'DOTA2', item.buffSellMinPrice,
    item.buffSellNum, item.steamPriceCny, item.afterTaxPrice, item.listingCostRate ?? item.sellRatio,
    item.steamBuyOrderPrice, item.steamQuickSellNetCny, item.quickSellCostRate, item.steamVolume,
    item.steamSellCount, item.liquidityDays, item.enrichedAt ? new Date(item.enrichedAt).toISOString() : '',
    `https://buff.163.com/goods/${item.id}`, item.steamMarketUrl || '', QUOTE_LABELS[quoteStatus(item)],
    item.buffFetchedAt ? new Date(item.buffFetchedAt).toISOString() : '', item.steamVerifiedAt ? new Date(item.steamVerifiedAt).toISOString() : ''
  ].map(escapeCSVCell).join(','));
  downloadFile(`steam-balance-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + [headers, ...rows].map(row => Array.isArray(row) ? row.map(escapeCSVCell).join(',') : row).join('\n'), 'text/csv;charset=utf-8');
}
function exportJSON() {
  if (!filteredItems.length) { feedback('当前没有可导出的结果。', true); return; }
  downloadFile(`steam-balance-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(filteredItems, null, 2), 'application/json');
}
async function downloadFile(name, contents, type) {
  try {
    const result = await window.desktop.exportFile({ type: name.endsWith('.csv') ? 'csv' : 'json', contents });
    if (!result.ok) feedback(result.error, true);
    else if (!result.cancelled) feedback('已导出到：' + result.path);
  } catch (error) { feedback(error.message, true); }
}

let isScanning = false;
let loading = false;
function ensurePolling() { if (!pollTimer) pollTimer = setInterval(loadData, 700); }
async function loadData() {
  if (loading) return;
  loading = true;
  try {
    const response = await sendMsg({ action: 'getLiveItems' });
    if (!response.ok) throw new Error(response.error || '扫描服务暂不可用');
    isScanning = Boolean(response.isScanning);
    isEnriching = Boolean(response.isEnriching);
    const hasLiveResult = Boolean(response.scanInfo?.startTime) || response.items?.length;
    let timestamp = response.scanInfo?.timestamp;
    if (hasLiveResult) allItems = response.items || [];
    else {
      const saved = await sendMsg({ action: 'getScanResult' });
      if (!saved.ok) throw new Error(saved.error || '读取本地数据失败');
      allItems = saved.result?.items || [];
      timestamp = saved.result?.timestamp;
    }
    applyFilters({ resetPage: false });
    $('ovScanTime').textContent = timestamp ? formatRelativeTime(timestamp) : '—';
    $('btnEnrichSteam').textContent = isEnriching ? '取消 Steam 复核' : '复核 Steam 行情';
    $('btnEnrichSteam').disabled = isScanning || !allItems.length;
    $('btnStartScan').disabled = isScanning || isEnriching;
    $('btnHistory').disabled = isScanning || isEnriching;
    $('btnStopScan').disabled = !isScanning;
    for (const id of ['gameSelect', 'scanMode', 'buffPage']) $(id).disabled = isScanning || isEnriching;
    const state = response.scanState || {};
    let status;
    if (isScanning) status = '扫描中 · 第 ' + (state.currentPage || 1) + ' 页 · ' + (state.scannedItems || 0) + ' / ' + (state.totalItems || '?') + ' 件';
    else if (isEnriching) status = 'Steam 行情复核中 · ' + (response.enrichProgress?.done || 0) + ' / ' + (response.enrichProgress?.total || 0) + ' 件（可取消）';
    else if (state.status === 'error' || state.status === 'aborted') status = (state.error || '扫描已中断') + (state.keptPreviousResult && allItems.length ? '（已保留上一轮结果）' : '');
    else if (state.status === 'restored') status = '已恢复历史结果 · ' + allItems.length + ' 件，使用原始行情时间。';
    else if (state.status === 'cancelled') status = '扫描已停止，已保留 ' + allItems.length + ' 件已获取数据。';
    else if (state.status === 'completed') status = '扫描完成 · 共 ' + allItems.length + ' 件，行情仅为估算。';
    else status = allItems.length ? '已恢复本地保存的 ' + allItems.length + ' 件数据。' : '准备就绪，请先登录 BUFF，再开始扫描。';
    $('scanStatus').textContent = status;
    $('scanStatus').classList.toggle('error', ['error', 'aborted'].includes(state.status));
    const progress = $('scanProgress');
    progress.hidden = !isScanning && !isEnriching;
    const total = isEnriching ? response.enrichProgress?.total : state.totalItems;
    const done = isEnriching ? response.enrichProgress?.done : state.scannedItems;
    if (total) { progress.max = total; progress.value = done || 0; } else progress.removeAttribute('value');
    $('btnExportCSV').disabled = $('btnExportJSON').disabled = !filteredItems.length;
    if (isScanning || isEnriching) ensurePolling();
    else if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  } catch (error) { feedback(error.message, true); }
  finally { loading = false; }
}
$('btnRefresh').addEventListener('click', loadData);
$('btnExportCSV').addEventListener('click', exportCSV);
$('btnExportJSON').addEventListener('click', exportJSON);
$('btnEnrichSteam').addEventListener('click', async () => {
  if (isEnriching) { await sendMsg({ action: 'stopEnrich' }); return; }
  const selection = [...filteredItems].sort((a, b) =>
    Number(quoteStatus(a) === 'fresh') - Number(quoteStatus(b) === 'fresh')
    || (a.steamAttemptedAt || 0) - (b.steamAttemptedAt || 0) || compareOpportunity(a, b));
  await reviewItems(selection);
});
$('btnStartScan').addEventListener('click', async () => {
  $('btnStartScan').disabled = true;
  feedback('');
  currentPage = 1;
  const result = await sendMsg({ action: 'startScan', game: $('gameSelect').value, scanMode: $('scanMode').value, page: Number($('buffPage').value) });
  if (!result.ok) { feedback(result.error, true); $('btnStartScan').disabled = false; return; }
  ensurePolling();
  await loadData();
});
$('btnStopScan').addEventListener('click', async () => {
  const result = await sendMsg({ action: 'stopScan' });
  feedback(result.ok ? '正在停止扫描…' : result.error, !result.ok);
});
$('scanMode').addEventListener('change', () => { $('pageField').hidden = $('scanMode').value !== 'current_page'; });
$('btnLogin').addEventListener('click', async () => {
  const result = await window.desktop.login();
  feedback(result.ok ? '请在独立窗口完成 BUFF 登录，回来点击「检查登录」。' : result.error, !result.ok);
});
$('btnCheckSession').addEventListener('click', async () => {
  $('btnCheckSession').disabled = true;
  $('sessionStatus').textContent = '正在检查 BUFF 会话…';
  try {
    const result = await window.desktop.checkSession();
    $('sessionStatus').textContent = result.ok && result.authenticated ? (result.demo ? '离线演示 · 无真实账号' : 'BUFF 会话可用') : result.message || result.error || '请先登录 BUFF';
  } catch (error) { $('sessionStatus').textContent = error.message; }
  finally { $('btnCheckSession').disabled = false; }
});
$('btnOpenData').addEventListener('click', async () => {
  const result = await window.desktop.openData();
  if (!result.ok) feedback(result.error, true);
});
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  event.preventDefault();
  window.desktop.openExternal(link.href).then(result => { if (!result.ok) feedback(result.error, true); });
});

const FILTER_IDS = ['candidateFilter','ratioFilter','maxLiquidityDays','minPrice','maxPrice','minBuffSellNum','minSteamVolume','gameFilter','sortBy','sortOrder','favoritesOnly','quoteFilter'];
const DEFAULT_FILTERS = Object.fromEntries(FILTER_IDS.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
function saveFilters() {
  const data = {};
  for (const id of FILTER_IDS) data[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  window.desktop.saveFilters(data).then(result => { if (!result.ok) feedback('筛选保存失败：' + result.error, true); }).catch(error => feedback(error.message, true));
}
async function restoreFilters() {
  const result = await window.desktop.getFilters();
  if (!result.ok) throw new Error(result.error || '读取筛选失败');
  const data = result.filters || {};
  for (const id of FILTER_IDS) {
    if (data[id] === undefined) continue;
    if ($(id).type === 'checkbox') $(id).checked = Boolean(data[id]);
    else $(id).value = data[id];
  }
}
function applyAndSave() { applyFilters(); saveFilters(); }
$('searchInput').addEventListener('input', applyAndSave);
for (const id of FILTER_IDS) $(id).addEventListener('input', applyAndSave);
$('btnResetFilters').addEventListener('click', () => {
  for (const [id, value] of Object.entries(DEFAULT_FILTERS)) {
    if ($(id).type === 'checkbox') $(id).checked = value; else $(id).value = value;
  }
  $('searchInput').value = '';
  applyAndSave();
});
$('btnNeedsReview').addEventListener('click', () => {
  $('candidateFilter').checked = false;
  $('quoteFilter').value = 'needs';
  $('ratioFilter').value = '';
  $('maxLiquidityDays').value = '';
  applyAndSave();
});
$('btnFailedReviews').addEventListener('click', () => {
  for (const [id, value] of Object.entries(DEFAULT_FILTERS)) {
    if ($(id).type === 'checkbox') $(id).checked = value; else $(id).value = value;
  }
  $('searchInput').value = '';
  $('candidateFilter').checked = false;
  $('quoteFilter').value = 'error';
  $('ratioFilter').value = $('maxLiquidityDays').value = '';
  applyAndSave();
});

(async function init() {
  try {
    const info = await window.desktop.getInfo();
    if (!info.ok) throw new Error(info.error);
    $('modeBadge').textContent = (info.demo ? '离线演示' : '独立桌面应用') + ' · v' + info.version;
    $('demoNotice').hidden = !info.demo;
    if (info.demo) $('sessionStatus').textContent = '演示模式不连接账号';
    $('btnLogin').disabled = info.demo;
    const savedFavorites = await window.desktop.getFavorites();
    if (!savedFavorites.ok) throw new Error(savedFavorites.error);
    favorites = new Set(savedFavorites.keys);
    await restoreFilters();
    await loadData();
    // Expiry must update even while idle, without issuing any market requests.
    setInterval(() => applyFilters({ resetPage: false }), 30_000);
  } catch (error) { feedback(error.message, true); }
})();
