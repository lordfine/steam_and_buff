// Shared economics, search and liquidity rules used by the popup and dashboard.
// Prices are estimates in CNY; Steam Wallet funds are not cash-withdrawable.
function getSteamNetPrice(grossPrice) {
  const gross = Number(grossPrice);
  if (!Number.isFinite(gross) || gross <= 0) return 0;
  return Number((gross / (1 + STEAM_TAX_RATE)).toFixed(2));
}

function calcCostRate(buffCost, steamGrossPrice) {
  const cost = Number(buffCost);
  const net = getSteamNetPrice(steamGrossPrice);
  if (!Number.isFinite(cost) || cost <= 0 || net <= 0) return null;
  return cost / net;
}

function calcReturnMultiple(buffCost, steamGrossPrice) {
  const cost = Number(buffCost);
  const net = getSteamNetPrice(steamGrossPrice);
  if (!Number.isFinite(cost) || cost <= 0 || net <= 0) return null;
  return net / cost;
}

function calcLiquidityDays(activeSellListings, volume24h) {
  if (activeSellListings === null || activeSellListings === undefined || activeSellListings === '') return null;
  const listings = Number(activeSellListings);
  const volume = Number(volume24h);
  if (!Number.isFinite(listings) || listings < 0 || !Number.isFinite(volume) || volume <= 0) return null;
  return listings / volume;
}

function parseSteamOrderPrice(value) {
  const minorUnits = Number.parseInt(String(value || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(minorUnits) ? minorUnits / 100 : 0;
}

function parseOrderSummaryCount(summary) {
  const match = String(summary || '').match(/[\d,]+/);
  return match ? Number.parseInt(match[0].replace(/,/g, ''), 10) || 0 : 0;
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[|_\-()[\]{}.,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesItemSearch(item, query) {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeSearchText([
    item?.name,
    item?.shortName,
    item?.marketHashName,
    item?.game,
    item?.id
  ].filter(Boolean).join(' '));
  return tokens.every(token => haystack.includes(token));
}

function rankItemSearch(item, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;
  const marketName = normalizeSearchText(item?.marketHashName);
  const names = [item?.name, item?.shortName].map(normalizeSearchText).filter(Boolean);
  if (marketName === normalizedQuery) return 0;
  if (names.includes(normalizedQuery)) return 1;
  if (marketName.includes(normalizedQuery) || names.some(name => name.includes(normalizedQuery))) return 2;
  return matchesItemSearch(item, normalizedQuery) ? 3 : Infinity;
}

// This is a conservative local freshness policy, not a guarantee of execution.
const QUOTE_MAX_AGE_MS = 30 * 60 * 1000;
function quoteStatus(item, now = Date.now()) {
  if (item?.steamEnrichError || item?.steamOrderbookError) return 'error';
  if (item?.steamUnsupported) return 'unsupported';
  if (item?.steamVerifiedAt && item?.buffFetchedAt) {
    const times = [item.steamVerifiedAt, item.buffFetchedAt];
    if (times.some(time => !Number.isFinite(time) || time <= 0 || time > now || now - time > QUOTE_MAX_AGE_MS)) return 'stale';
    if (item.steamOrderbookAvailable) return 'fresh';
  }
  return item?.steamAttemptedAt || item?.steamEnriched || item?.steamOrderbookAvailable ? 'partial' : 'pending';
}

function isOpportunityCandidate(item, { maxCostRate = 0.75, maxLiquidityDays = 3, now = Date.now() } = {}) {
  const costRate = item?.steamOrderbookAvailable ? (item?.quickSellCostRate ?? null) : null;
  const days = item?.liquidityDays ?? null;
  return quoteStatus(item, now) === 'fresh'
    && Number.isFinite(costRate) && costRate > 0 && costRate <= maxCostRate
    && Number.isFinite(days) && days >= 0 && days <= maxLiquidityDays;
}

function getPendingOpportunityItems(items, { maxCostRate = 0.75, limit = 20 } = {}) {
  return (Array.isArray(items) ? items : [])
    .filter(item => !item?.steamEnriched && !item?.steamUnsupported
      && item?.sellRatio !== null && item?.sellRatio !== undefined
      && Number.isFinite(Number(item.sellRatio)) && Number(item.sellRatio) <= maxCostRate)
    .sort((a, b) => (Number(a.sellRatio) - Number(b.sellRatio))
      || (Number(b.buffSellNum) || 0) - (Number(a.buffSellNum) || 0))
    .slice(0, Math.max(0, limit));
}

function compareOpportunity(a, b, options = {}) {
  const aEligible = isOpportunityCandidate(a, options);
  const bEligible = isOpportunityCandidate(b, options);
  if (aEligible !== bEligible) return aEligible ? -1 : 1;

  const aRate = a.quickSellCostRate ?? a.sellRatio ?? Infinity;
  const bRate = b.quickSellCostRate ?? b.sellRatio ?? Infinity;
  if (aRate !== bRate) return aRate - bRate;

  const aDays = a.liquidityDays ?? Infinity;
  const bDays = b.liquidityDays ?? Infinity;
  if (aDays !== bDays) return aDays - bDays;

  const volumeDiff = (Number(b.steamVolume) || 0) - (Number(a.steamVolume) || 0);
  if (volumeDiff) return volumeDiff;
  return (Number(b.buffSellNum) || 0) - (Number(a.buffSellNum) || 0);
}
