// Regression for logged-in BUFF sessions whose cookie is not visible through
// chrome.cookies.getAll (the authenticated API request remains the authority).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const storage = {};
let buffFetches = 0;
let buffAuthCode = 'OK';

const chrome = {
  alarms: { onAlarm: { addListener() {} }, create() {}, clear() {} },
  cookies: { getAll(_query, callback) { callback([]); } },
  runtime: { lastError: null, onMessage: { addListener() {} } },
  storage: { local: {
    set(values, callback) { Object.assign(storage, values); callback?.(); },
    get(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      const result = Object.fromEntries(list.filter(key => key in storage).map(key => [key, storage[key]]));
      callback(result);
    },
    remove(keys, callback) { for (const key of keys) delete storage[key]; callback?.(); }
  } },
  tabs: { query: async () => [] }
};

const context = vm.createContext({
  chrome, console, URL, URLSearchParams, AbortController, DOMException,
  setTimeout, clearTimeout,
  fetch: async url => {
    if (String(url).includes('buff.163.com/api/market/goods')) {
      buffFetches++;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
        code: buffAuthCode, error: buffAuthCode === 'OK' ? '' : buffAuthCode,
        data: { total_count: 0, items: [] }
      }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  },
  importScripts(...files) {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
});

(async () => {
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  await context.startScan('csgo', 'all');
  const state = storage.scanState;
  const passed = buffFetches === 1 && state?.status === 'completed';
  console.log(`${passed ? 'PASS' : 'FAIL'}: valid BUFF API session is accepted when chrome.cookies.getAll returns no cookies`);
  if (!passed) {
    console.log(`  fetches=${buffFetches}, scanState=${JSON.stringify(state)}`);
    process.exitCode = 1;
  }

  buffAuthCode = 'Login Required';
  await context.startScan('csgo', 'all');
  const authError = storage.scanState?.error || '';
  const authFailureIsClear = storage.scanState?.status === 'error'
    && authError.includes('BUFF API 返回未授权')
    && !authError.includes('未检测到 BUFF 登录状态');
  console.log(`${authFailureIsClear ? 'PASS' : 'FAIL'}: genuine BUFF API auth failure reports the server response, not a cookie false negative`);
  if (!authFailureIsClear) {
    console.log(`  scanState=${JSON.stringify(storage.scanState)}`);
    process.exitCode = 1;
  }
})();
