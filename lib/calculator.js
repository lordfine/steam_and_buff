function calcAfterTaxPrice(steamPrice) {
  return steamPrice / (1 + STEAM_TAX_RATE);
}

function calcBalanceRatio(buffPrice, steamPrice) {
  if (!steamPrice || steamPrice <= 0) return null;
  const afterTax = calcAfterTaxPrice(steamPrice);
  if (afterTax <= 0) return null;
  return buffPrice / afterTax;
}

function parseSteamPrice(priceStr) {
  if (!priceStr || typeof priceStr !== 'string') return 0;
  const num = parseFloat(priceStr.replace(/[^\d.]/g, ''));
  return isNaN(num) ? 0 : num;
}

function calcItemData(buffItem) {
  const buffPrice = parseFloat(buffItem.sell_min_price) || 0;
  const buffBuyPrice = parseFloat(buffItem.buy_max_price) || 0;
  const steamPriceCny = parseFloat(buffItem.goods_info?.steam_price_cny) || 0;
  const steamPriceUsd = parseFloat(buffItem.goods_info?.steam_price) || 0;

  const sellRatio = calcBalanceRatio(buffPrice, steamPriceCny);
  const buyRatio = calcBalanceRatio(buffBuyPrice, steamPriceCny);

  return {
    id: buffItem.id,
    name: buffItem.name,
    shortName: buffItem.short_name || buffItem.name,
    marketHashName: buffItem.market_hash_name,
    game: buffItem.game,
    appid: buffItem.appid,
    iconUrl: buffItem.goods_info?.icon_url || '',
    steamMarketUrl: buffItem.steam_market_url || '',
    buffSellMinPrice: buffPrice,
    buffBuyMaxPrice: buffBuyPrice,
    buffSellNum: buffItem.sell_num || 0,
    buffBuyNum: buffItem.buy_num || 0,
    steamPriceCny: steamPriceCny,
    steamPriceUsd: steamPriceUsd,
    steamBuyOrderPrice: 0,
    steamQuickSellNetCny: 0,
    quickSellCostRate: null,
    quickSellReturnMultiple: null,
    steamSellCount: null,
    steamBuyCount: 0,
    steamVolume: null,
    liquidityDays: null,
    steamNameId: null,
    steamOrderbookAvailable: false,
    steamOrderbookError: '',
    steamOrderbookUnsupported: false,
    afterTaxPrice: steamPriceCny > 0 ? calcAfterTaxPrice(steamPriceCny) : 0,
    sellRatio: sellRatio,
    listingCostRate: sellRatio,
    returnMultiple: buffPrice > 0 && steamPriceCny > 0
      ? calcAfterTaxPrice(steamPriceCny) / buffPrice
      : null,
    buyRatio: buyRatio,
    profitable: sellRatio !== null && sellRatio < 1,
    steamEnriched: false,
    steamUnsupported: false,
    buffFetchedAt: Date.now(),
    steamVerifiedAt: null,
    steamAttemptedAt: null,
    steamEnrichError: '',
    enrichedAt: null
  };
}
