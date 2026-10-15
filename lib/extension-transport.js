// Extension-only network adapter. Desktop supplies its own isolated transport.
// A session DNR rule adds a non-auth market layout preference to THIS extension's
// listing requests only. It never reads cookies or writes the browser cookie jar.
let steamLegacyRuleReady;
async function fetchMarket(input, options = {}) {
  if (!chrome.declarativeNetRequest || !chrome.runtime.id) return fetch(input, options);
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['buff.163.com', 'steamcommunity.com'].includes(url.hostname)) throw new Error('不允许的市场请求');
  const { steamMarketLegacy, ...init } = options;
  if (steamMarketLegacy) {
    if (url.hostname !== 'steamcommunity.com' || !url.pathname.startsWith('/market/listings/')) throw new Error('兼容选项仅适用于 Steam 商品页');
    steamLegacyRuleReady ||= chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [23001], addRules: [{ id: 23001, priority: 1,
        condition: { regexFilter: '^https://steamcommunity\\.com/market/listings/',
          initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'append', value: 'bMarketOptOut=1' }] }
      }]
    }).catch(error => { steamLegacyRuleReady = null; throw error; });
    await steamLegacyRuleReady;
  }
  const timeout = AbortSignal.timeout(30000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal, credentials: 'include', redirect: 'error' });
}
