function parsedHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}
function isMarketUrl(value) {
  const url = parsedHttps(value);
  return Boolean(url && ['buff.163.com', 'steamcommunity.com'].includes(url.hostname));
}
function isLoginUrl(value) {
  const url = parsedHttps(value);
  return Boolean(url && (['steamcommunity.com', 'store.steampowered.com', 'login.steampowered.com', '163.com'].includes(url.hostname)
    || url.hostname.endsWith('.163.com')));
}
function createMarketFetch(session) {
  let legacyPreference;
  return (input, options = {}) => {
    if (!isMarketUrl(input)) throw new Error('只允许请求 BUFF 和 Steam 市场');
    const timeout = AbortSignal.timeout(30000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const { steamMarketLegacy, ...requestOptions } = options;
    const request = () => session.fetch(input, { ...requestOptions, signal, credentials: 'include', redirect: 'error' });
    if (!steamMarketLegacy) return request();
    const url = new URL(input);
    if (url.hostname !== 'steamcommunity.com' || !url.pathname.startsWith('/market/listings/')) throw new Error('市场兼容选项仅适用于 Steam 商品页');
    if (!session.cookies?.set) throw new Error('当前网络环境不支持 Steam 兼容页面，请使用桌面版');
    // Same non-auth preference as Steam's own Exit Market Beta button. It is
    // scoped to this application's session, not the user's Chrome or account.
    legacyPreference ||= session.cookies.set({ url: 'https://steamcommunity.com/market/', path: '/market',
      name: 'bMarketOptOut', value: '1', secure: true, httpOnly: false }).catch(error => { legacyPreference = null; throw error; });
    return legacyPreference.then(request);
  };
}
module.exports = { isMarketUrl, isLoginUrl, createMarketFetch };
