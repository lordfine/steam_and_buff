// Pure parsing only: never execute scripts embedded in a remote Steam page.
// Support the current Valve SSR format and the official legacy market layout.
function parseSteamMarketPage(html, appid, marketHashName, currency = 23) {
  const legacy = html.match(/Market_LoadOrderSpread\s*\(\s*(\d+)\s*\)/i)
    || html.match(/[?&]item_nameid=(\d+)/i);
  if (legacy) {
    const itemNameId = Number(legacy[1]);
    if (Number.isSafeInteger(itemNameId) && itemNameId > 0) return { kind: 'legacy', itemNameId };
  }
  const script = html.match(/<script\b[^>]*\bid\s*=\s*["']valve-ssr-data["'][^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!script) return { kind: 'unavailable', reason: '页面未提供求购盘数据，可能需要登录、验证或稍后重试' };
  try {
    const ssr = JSON.parse(script[1]);
    const raw = ssr.renderContext?.queryData;
    const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const query = state?.queries?.find(entry => {
      const key = entry.queryKey;
      return Array.isArray(key) && key.length === 4 && key[0] === 'market' && key[1] === 'orderbook'
        && Number(key[2]) === Number(appid) && key[3] === marketHashName;
    });
    const book = query?.state?.status === 'success' && query.state.data;
    if (!book) return { kind: 'unavailable', reason: '新版页面未返回该饰品的精确求购盘' };
    if (book.eCurrency !== currency) return { kind: 'unavailable', reason: `新版页面币种不是人民币（currency=${book.eCurrency}），不能用于人民币估算` };
    if (['amtMaxBuyOrder', 'amtMinSellOrder', 'cBuyOrders', 'cSellOrders'].some(key => !Number.isSafeInteger(book[key]) || book[key] < 0)) {
      return { kind: 'unavailable', reason: '新版求购盘数值不完整或格式无效' };
    }
    return { kind: 'orderbook', data: {
      success: 1, highest_buy_order: String(book.amtMaxBuyOrder), lowest_sell_order: String(book.amtMinSellOrder),
      buy_order_summary: String(book.cBuyOrders), sellOrderCount: book.cSellOrders
    } };
  } catch { return { kind: 'unavailable', reason: '新版 Steam 页面数据格式无法解析' }; }
}

function parseSteamOrderCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  const text = String(value ?? '').trim();
  // Steam's histogram summary starts with the TOTAL, unlike its depth graph
  // whose last cumulative entry covers only part of the price range.
  const match = text.match(/^<span\b[^>]*class=["'][^"']*\bmarket_commodity_orders_header_promote\b[^"']*["'][^>]*>([\d,\s]+)<\/span>/i);
  const digits = /^[\d][\d,\s]*$/.test(text) ? text : match?.[1];
  if (digits === undefined) return null;
  const count = Number(digits.replace(/[,\s]/g, ''));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
