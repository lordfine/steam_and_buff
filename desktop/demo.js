// Deterministic, synthetic prices. Never contacts BUFF or Steam and uses a separate profile.
function demoFetch(input, options = {}) {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = new URL(input);
  const game = url.searchParams.get('game') || 'csgo';
  const names = ['演示 · 赤红饰品', '演示 · 蓝色饰品', '演示 · 稀有饰品'];
  let body;
  if (url.hostname === 'buff.163.com') {
    body = { code: 'OK', data: { total_count: 3, items: names.map((name, index) => ({
      id: 900001 + index, name, short_name: name, market_hash_name: `Demo Item ${index + 1}`,
      game, appid: game === 'csgo' ? 730 : 570, sell_min_price: [60, 70, 100][index],
      sell_num: 100 + index, goods_info: { steam_price_cny: 115 }
    })) } };
  } else if (url.pathname.includes('priceoverview')) {
    body = { success: true, lowest_price: '¥ 115.00', volume: '100' };
  } else if (url.pathname.includes('search/render')) {
    body = { success: true, results: [{ hash_name: url.searchParams.get('query'), sell_listings: 150 }] };
  } else if (url.pathname.includes('itemordershistogram')) {
    body = { success: true, highest_buy_order: '11500', lowest_sell_order: '11500', buy_order_summary: '200' };
  } else if (url.pathname.includes('/market/listings/')) {
    return Promise.resolve(new Response('Market_LoadOrderSpread(123456);'));
  } else throw new Error(`Unexpected demo request: ${url.pathname}`);
  return Promise.resolve(Response.json(body));
}
module.exports = { demoFetch };
