const GAMES = {
  dota2: { appid: 570, name: 'DOTA2', buffGame: 'dota2' },
  csgo: { appid: 730, name: 'CS2', buffGame: 'csgo' }
};

const BUFF_API_BASE = 'https://buff.163.com/api/market/goods';
const STEAM_PRICE_API = 'https://steamcommunity.com/market/priceoverview';
// search/render 直接接受 market_hash_name + appid，返回 sell_listings/sell_price
// Listing pages may use Valve SSR; the desktop transport also supports Steam's legacy-layout preference.
const STEAM_SEARCH_API = 'https://steamcommunity.com/market/search/render/';
const STEAM_CURRENCY_CNY = 23;
const STEAM_TAX_RATE = 0.15;
const STEAM_COUNTRY = 'CN';
const STEAM_LANGUAGE = 'schinese';
const BUFF_PAGE_SIZE = 80;
const BUFF_REQUEST_INTERVAL = 3000;
const BUFF_MAX_RETRIES = 5;
const BUFF_RETRY_BASE_DELAY = 5000;
const STEAM_REQUEST_INTERVAL = 5000;
const DEFAULT_COST_RATE = 0.75;
const DEFAULT_LIQUIDITY_DAYS = 3;
const STEAM_ENRICH_BATCH_SIZE = 20;

const STORAGE_KEYS = {
  SCAN_RESULT: 'scanResult',
  SCAN_STATE: 'scanState',
  STEAM_NAME_IDS: 'steamNameIds',
  OPPORTUNITY_SETTINGS: 'opportunitySettings'
};
