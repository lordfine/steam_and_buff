const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHistory } = require('./history');

const ACTIONS = new Set(['startScan', 'stopScan', 'getLiveItems', 'getScanResult', 'enrichSteam', 'stopEnrich', 'checkScanHealth', 'listHistory', 'restoreHistory']);

// Host the existing, tested scan/calculation pipeline in a long-lived desktop process.
// The renderer never receives Node access, arbitrary fetch, or an arbitrary IPC channel.
function createEngine({ store, fetch, wait }) {
  const root = path.join(__dirname, '..');
  const alarms = new Map();
  let messageListener;
  let alarmListener;
  let page = 1;
  let closing = false;
  let preparing = false;
  const history = createHistory(store);
  const runtime = { lastError: null, onMessage: { addListener(fn) { messageListener = fn; } } };
  function callbackResult(operation, callback) {
    Promise.resolve(operation).then(() => callback?.(), error => {
      runtime.lastError = { message: error.message };
      try { callback?.(); } finally { runtime.lastError = null; }
    });
  }
  const chrome = {
    runtime,
    storage: { local: {
      get(keys, callback) { callback(store.get(keys)); },
      set(values, callback) { callbackResult(store.set(values), callback); },
      remove(keys, callback) { callbackResult(store.remove(keys), callback); }
    } },
    alarms: {
      onAlarm: { addListener(fn) { alarmListener = fn; } },
      create(name, { periodInMinutes }) {
        if (alarms.has(name)) clearInterval(alarms.get(name));
        const timer = setInterval(() => Promise.resolve(alarmListener?.({ name })).catch(console.error), periodInMinutes * 60000);
        timer.unref();
        alarms.set(name, timer);
      },
      clear(name) { clearInterval(alarms.get(name)); alarms.delete(name); }
    },
    tabs: { query: async () => [{ url: `https://buff.163.com/market/?page_num=${page}` }] }
  };
  const context = vm.createContext({
    chrome, fetch, console, URL, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout,
    importScripts(...files) {
      for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  if (wait) context.sleep = wait;

  return {
    async request(message) {
      if (!message || !ACTIONS.has(message.action)) return Promise.resolve({ ok: false, error: '不支持的操作' });
      if (closing && ['startScan', 'enrichSteam', 'restoreHistory'].includes(message.action)) return { ok: false, error: '应用正在退出' };
      const busy = preparing || vm.runInContext('isScanning || isEnriching', context);
      if (['startScan', 'enrichSteam', 'restoreHistory'].includes(message.action) && busy) {
        return Promise.resolve({ ok: false, error: '扫描或行情复核正在进行，请先停止或等待完成。' });
      }
      if (message.action === 'startScan') {
        if (!['csgo', 'dota2'].includes(message.game) || !['all', 'current_page'].includes(message.scanMode)) {
          return Promise.resolve({ ok: false, error: '游戏或扫描范围无效' });
        }
        page = Number(message.page ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 10000) return Promise.resolve({ ok: false, error: '页码必须是 1–10000 的整数' });
      }
      if (message.action === 'enrichSteam' && (!Array.isArray(message.itemIds) || !message.itemIds.length || message.itemIds.length > 20)) {
        return Promise.resolve({ ok: false, error: '每批请选择 1–20 件物品' });
      }
      if (message.action === 'listHistory') return { ok: true, history: history.list() };
      if (['startScan', 'restoreHistory'].includes(message.action)) {
        preparing = true;
        try {
          if (message.action === 'restoreHistory') {
            const result = await history.restore(message.id);
            context.adoptScanSnapshot(result);
            return { ok: true };
          }
          await history.archive();
          if (closing) return { ok: false, error: '应用正在退出' };
        } catch (error) { return { ok: false, error: error.message }; }
        finally { preparing = false; }
      }
      return new Promise((resolve, reject) => {
        try { messageListener(message, {}, response => resolve(structuredClone(response))); }
        catch (error) { reject(error); }
      });
    },
    async close() {
      closing = true;
      await this.request({ action: 'stopScan' });
      await this.request({ action: 'stopEnrich' });
      // Aborted fetches settle and the pipeline saves its final snapshot before exit.
      while (preparing || vm.runInContext('isScanning || isEnriching', context)) {
        await this.request({ action: 'stopScan' });
        await this.request({ action: 'stopEnrich' });
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      for (const timer of alarms.values()) clearInterval(timer);
      await store.flush();
    }
  };
}
module.exports = { createEngine };
