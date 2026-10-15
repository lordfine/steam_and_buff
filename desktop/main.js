const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStore } = require('./store');
const { createEngine } = require('./engine');
const { demoFetch } = require('./demo');
const { isMarketUrl, isLoginUrl, createMarketFetch } = require('./security');

const demo = process.argv.includes('--demo');
const development = !app.isPackaged && process.argv.includes('--dev');
// Demo data, cookies, and filters are never mixed into the real profile.
const dataOverride = process.env.STEAM_BALANCE_DATA_DIR && path.resolve(process.env.STEAM_BALANCE_DATA_DIR);
const dataDirectory = dataOverride || path.join(app.getPath('appData'), demo ? 'steam-balance-demo' : 'steam-balance-desktop');
fs.mkdirSync(dataDirectory, { recursive: true });
app.setPath('userData', dataDirectory);
app.setPath('sessionData', dataDirectory);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow;
let loginWindow;
let engine;
let store;
let marketSession;
let quitting = false;
const indexPath = path.join(__dirname, 'index.html');
const indexUrl = pathToFileURL(indexPath).href;

function guardWindow(window, remote = false) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (remote && isLoginUrl(url)) {
      window.loadURL(url).catch(error => dialog.showErrorBox('登录页面打开失败', error.message));
    } else if (isMarketUrl(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  for (const eventName of ['will-navigate', 'will-redirect']) {
    contents.on(eventName, (event, url) => {
      if (remote ? !isLoginUrl(url) : url !== indexUrl) event.preventDefault();
    });
  }
  contents.on('will-attach-webview', event => event.preventDefault());
}

function openLogin() {
  if (demo) return { ok: false, error: '离线演示模式不连接账号。关闭后用正常模式启动即可登录。' };
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.show(); loginWindow.focus(); return { ok: true }; }
  loginWindow = new BrowserWindow({
    width: 1100, height: 800, title: 'BUFF 登录 · SkinLedger · 饰账', autoHideMenuBar: true,
    parent: mainWindow,
    webPreferences: { session: marketSession, nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  guardWindow(loginWindow, true);
  loginWindow.on('closed', () => { loginWindow = null; });
  loginWindow.loadURL('https://buff.163.com/market/csgo').catch(error => dialog.showErrorBox('BUFF 无法打开', error.message));
  return { ok: true };
}

function registerIpc() {
  let favoriteQueue = Promise.resolve();
  function handle(channel, handler) {
    ipcMain.handle(`desktop:${channel}`, async (event, ...args) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
        || event.senderFrame.url !== indexUrl) throw new Error('不可信的调用来源');
      try { return await handler(...args); }
      catch (error) { console.error(channel, error); return { ok: false, error: error.message }; }
    });
  }
  handle('request', message => engine.request(message));
  handle('info', () => ({ ok: true, version: app.getVersion(), demo, dataPath: app.getPath('userData') }));
  handle('login', openLogin);
  handle('session', async () => {
    if (demo) return { ok: true, authenticated: true, demo: true };
    const response = await createMarketFetch(marketSession)('https://buff.163.com/api/market/goods?game=csgo&page_num=1&page_size=1', {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`BUFF HTTP ${response.status}`);
    const data = await response.json();
    return { ok: true, authenticated: data.code === 'OK', message: data.code === 'OK' ? 'BUFF 会话可用' : `BUFF 返回：${data.code || '未知状态'}，请在登录窗口完成登录。` };
  });
  handle('getFilters', () => ({ ok: true, filters: store.get('dashboardFilters').dashboardFilters || {} }));
  handle('saveFilters', async filters => {
    const allowed = ['candidateFilter', 'ratioFilter', 'maxLiquidityDays', 'minPrice', 'maxPrice', 'minBuffSellNum', 'minSteamVolume', 'gameFilter', 'sortBy', 'sortOrder', 'favoritesOnly', 'quoteFilter'];
    if (!filters || typeof filters !== 'object') throw new Error('筛选格式无效');
    const safe = Object.fromEntries(allowed.filter(key => Object.hasOwn(filters, key)).map(key => [key, filters[key]]));
    if (Object.values(safe).some(value => !['string', 'boolean', 'number'].includes(typeof value)) || JSON.stringify(safe).length > 4096) throw new Error('筛选值无效');
    await store.set({ dashboardFilters: safe });
    return { ok: true };
  });
  handle('getFavorites', () => ({ ok: true, keys: store.get('favorites').favorites || [] }));
  handle('setFavorite', (key, selected) => {
    if (typeof key !== 'string' || !/^(csgo|dota2):\d{1,16}$/.test(key) || typeof selected !== 'boolean') throw new Error('收藏标识无效');
    const update = favoriteQueue.then(async () => {
      const keys = new Set(store.get('favorites').favorites || []);
      if (selected) keys.add(key); else keys.delete(key);
      if (keys.size > 2000) throw new Error('最多收藏 2000 件饰品');
      await store.set({ favorites: [...keys] });
      return { ok: true, keys: [...keys] };
    });
    favoriteQueue = update.catch(() => {});
    return update;
  });
  handle('export', async file => {
    if (!file || !['csv', 'json'].includes(file.type) || typeof file.contents !== 'string' || file.contents.length > 50_000_000) throw new Error('导出格式或大小无效');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出筛选结果', defaultPath: `steam-balance-${new Date().toISOString().slice(0, 10)}.${file.type}`,
      filters: [{ name: file.type.toUpperCase(), extensions: [file.type] }]
    });
    if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
    const target = result.filePath;
    // Preserve an existing export and replace atomically.
    if (fs.existsSync(target)) await fs.promises.copyFile(target, `${target}.bak`);
    await fs.promises.writeFile(`${target}.tmp`, file.contents, 'utf8');
    await fs.promises.rename(`${target}.tmp`, target);
    return { ok: true, path: target };
  });
  handle('openData', async () => {
    const error = await shell.openPath(app.getPath('userData'));
    if (error) throw new Error(error);
    return { ok: true };
  });
  handle('external', async url => {
    if (!isMarketUrl(url)) throw new Error('仅允许打开 BUFF 或 Steam 的 HTTPS 页面');
    await shell.openExternal(url);
    return { ok: true };
  });
}

app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!engine || quitting) return;
  event.preventDefault();
  quitting = true;
  engine.close().then(async () => {
    await marketSession.cookies.flushStore();
    marketSession.flushStorageData();
  }).catch(console.error).finally(() => app.quit());
});

if (singleInstance) app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  store = createStore(app.getPath('userData'));
  marketSession = session.fromPartition('persist:market');
  marketSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  marketSession.setPermissionCheckHandler(() => false);
  marketSession.on('will-download', event => event.preventDefault());
  engine = createEngine({
    store, fetch: demo ? demoFetch : createMarketFetch(marketSession),
    wait: demo ? ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 60))) : undefined
  });
  mainWindow = new BrowserWindow({
    width: 1500, height: 980, minWidth: 1000, minHeight: 680,
    title: 'Steam 倒余额 · 本地版', backgroundColor: '#f5f6fa', show: false,
    icon: path.join(__dirname, '..', 'icons', 'icon128.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  guardWindow(mainWindow);
  // Closing the workspace also closes a still-open login window, after saving.
  mainWindow.on('close', event => {
    if (!quitting) { event.preventDefault(); app.quit(); }
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      mainWindow.webContents.reloadIgnoringCache();
    }
  });
  registerIpc();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(indexPath).catch(error => dialog.showErrorBox('应用打开失败', error.message));
  if (development) mainWindow.webContents.openDevTools({ mode: 'detach' });
}).catch(error => { dialog.showErrorBox('Steam 倒余额启动失败', error.message); app.quit(); });
