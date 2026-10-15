const path = require('node:path');
const { app, BrowserWindow, dialog, session } = require('electron');
const { CollectionStore, createDefaultState } = require('./collection-store.cjs');
const { LibraryService } = require('./library-service.cjs');
const { ArchiveService } = require('./archive-service.cjs');
const { ReaderService } = require('./reader-service.cjs');
const { registerIpc } = require('./ipc.cjs');
const { createStartupWarning, combineStartupWarnings } = require('./startup-warning.cjs');
const {
  resolveDataDirectory,
  resolveLegacyDataDirectories,
  migrateLegacyDataDirectory,
  ensureDataDirectoryWritable
} = require('./data-directory.cjs');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow = null;
let splashWindow = null;
let library = null;
let store = null;
let archive = null;
let reader = null;
const startupWarnings = [];
let mainWindowReady = false;
let startupComplete = false;
let startupFinishing = false;
let splashReady = false;
let splashLoadFailed = false;
let splashShown = false;
let splashClosing = false;
let mainWindowSettings = null;
let pendingSecondInstanceFocus = false;
let appExiting = false;
let shutdownPromise = null;
let shutdownAllowQuit = false;
let splashState = { text: '正在启动', percent: 0.04, theme: 'dark' };
const SPLASH_STAGES = new Set([
  '正在启动',
  '正在读取配置',
  '正在准备书库',
  '正在扫描书库',
  '正在准备界面',
  '启动完成',
  '启动遇到问题'
]);

function resolveDataDir() {
  return resolveDataDirectory({
    isPackaged: app.isPackaged,
    env: process.env,
    executablePath: process.execPath,
    projectRoot: path.resolve(__dirname, '..', '..')
  });
}

function defaultWindowBounds() {
  return { width: 1360, height: 860 };
}

function bringMainWindowToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try { mainWindow.moveTop(); } catch (_) {}
  try { app.focus({ steal: true }); } catch (_) {}
  try { mainWindow.focus(); } catch (_) {}
  return true;
}

function focusMainWindow() {
  if (appExiting || !mainWindow || mainWindow.isDestroyed() || !mainWindowReady || !startupComplete) {
    if (!appExiting) pendingSecondInstanceFocus = true;
    return false;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  bringMainWindowToFront();
  pendingSecondInstanceFocus = false;
  return true;
}

function executeSplash(script) {
  if (!splashWindow || splashWindow.isDestroyed() || !splashReady) return;
  splashWindow.webContents.executeJavaScript(script, true).catch(() => {});
}

function updateSplashState(next = {}) {
  if (SPLASH_STAGES.has(next.text)) splashState.text = next.text;
  if (Number.isFinite(Number(next.percent))) splashState.percent = Math.min(1, Math.max(0, Number(next.percent)));
  if (next.theme === 'light' || next.theme === 'dark') splashState.theme = next.theme;
  executeSplash(`window.__setSplashState(${JSON.stringify(splashState)})`);
}

function createSplashWindow(theme = 'dark') {
  splashState.theme = theme === 'light' ? 'light' : 'dark';
  splashLoadFailed = false;
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: '图文阅读器启动中',
    backgroundColor: theme === 'light' ? '#f2f4f3' : '#101312',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  splashWindow.webContents.on('did-finish-load', () => {
    splashReady = true;
    updateSplashState(splashState);
  });
  splashWindow.webContents.on('did-fail-load', () => {
    splashReady = false;
    splashLoadFailed = true;
  });
  splashWindow.once('ready-to-show', () => {
    if (!splashWindow.isDestroyed() && !splashClosing) {
      splashWindow.show();
      splashShown = true;
    }
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
    splashReady = false;
    splashLoadFailed = false;
    splashShown = false;
    splashClosing = false;
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => {});
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const warning = combineStartupWarnings(startupWarnings.splice(0));
  try { mainWindow.setOpacity(0); } catch (_) {}
  mainWindow.show();
  if (pendingSecondInstanceFocus) focusMainWindow();
  else bringMainWindowToFront();
  let opacity = 0;
  const startedAt = Date.now();
  const fadeTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(fadeTimer);
      return;
    }
    opacity = Math.min(1, (Date.now() - startedAt) / 260);
    try { mainWindow.setOpacity(opacity); } catch (_) { opacity = 1; }
    if (opacity >= 1) {
      clearInterval(fadeTimer);
      if (warning) dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '数据读取提示',
        message: warning.message,
        detail: warning.detail
      });
    }
  }, 16);
}

function finishStartup() {
  if (!startupComplete || !mainWindowReady || startupFinishing) return;
  startupFinishing = true;
  updateSplashState({ text: '启动完成', percent: 1 });
  const reveal = () => {
    if (splashClosing) return;
    if (splashWindow && !splashWindow.isDestroyed()) {
      if (!splashShown && !splashLoadFailed) {
        splashWindow.webContents.once('ready-to-show', reveal);
        return;
      }
      splashClosing = true;
      executeSplash('window.__finishSplash()');
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
        revealMainWindow();
      }, 280);
      return;
    }
    revealMainWindow();
  };
  if (splashWindow && !splashWindow.isDestroyed() && !splashReady && !splashLoadFailed) {
    splashWindow.webContents.once('did-finish-load', reveal);
    splashWindow.webContents.once('ready-to-show', reveal);
    splashWindow.webContents.once('did-fail-load', reveal);
  } else {
    reveal();
  }
}

function markStartupComplete() {
  startupComplete = true;
  finishStartup();
}

function createWindow(settings, { load = true, startupManaged = false } = {}) {
  mainWindowSettings = settings || createDefaultState().settings;
  mainWindowReady = false;
  mainWindow = new BrowserWindow({
    ...defaultWindowBounds(),
    minWidth: 980,
    minHeight: 680,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    backgroundColor: '#101312',
    title: '图文阅读器',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  mainWindow.center();

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  const window = mainWindow;
  const sendFullscreenState = (value) => {
    if (!window.isDestroyed()) window.webContents.send('app:fullscreen-changed', value);
  };
  window.on('enter-full-screen', () => sendFullscreenState(true));
  window.on('leave-full-screen', () => sendFullscreenState(false));
  mainWindow.once('ready-to-show', () => {
    mainWindowReady = true;
    if (startupManaged) finishStartup();
    else revealMainWindow();
    if (!startupManaged && pendingSecondInstanceFocus) focusMainWindow();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    mainWindowReady = false;
  });
  if (load) mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'));
}

async function initialize() {
  createWindow(createDefaultState().settings, { load: false, startupManaged: true });
  createSplashWindow('dark');
  updateSplashState({ text: '正在启动', percent: 0.04 });
  const dataDir = resolveDataDir();
  await ensureDataDirectoryWritable(dataDir);
  const legacyDataDirs = resolveLegacyDataDirectories({
    isPackaged: app.isPackaged,
    env: process.env,
    homePath: app.getPath('home')
  });
  updateSplashState({ text: '正在读取配置', percent: 0.12 });
  for (const legacyDataDir of legacyDataDirs) {
    try {
      const migrated = await migrateLegacyDataDirectory(legacyDataDir, dataDir);
      if (migrated) break;
    } catch (error) {
      startupWarnings.push(createStartupWarning('LEGACY_DATA_MIGRATION_FAILED', error));
      break;
    }
  }
  updateSplashState({ text: '正在准备书库', percent: 0.28 });
  store = new CollectionStore(dataDir);
  library = new LibraryService(store);
  try {
    await library.initialize();
  } catch (error) {
    startupWarnings.push(createStartupWarning(
      error?.code === 'COLLECTION_CONFIG_BROKEN' ? 'CONFIG_RECOVERY_REQUIRED' : 'STARTUP_DATA_READ_FAILED',
      error
    ));
    library.activateRecoveryMode(createDefaultState());
  }
  updateSplashState({ text: '正在准备书库', percent: 0.45, theme: library.state.settings.theme });
  archive = new ArchiveService(dataDir);
  await archive.initialize();
  reader = new ReaderService(library, archive);
  registerIpc({
    library,
    store,
    reader,
    getWindow: () => mainWindow,
    dataDir,
    onStartupProgress: updateSplashState,
    onStartupComplete: markStartupComplete
  });

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindowSettings = library.state.settings;
  updateSplashState({ text: '正在准备界面', percent: 0.56, theme: mainWindowSettings.theme });
  mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'));
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    focusMainWindow();
  });
  app.on('before-quit', (event) => {
    appExiting = true;
    if (shutdownAllowQuit) return;
    if (shutdownPromise) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    shutdownPromise = Promise.resolve(reader?.shutdown())
      .catch(() => {})
      .finally(() => {
        shutdownAllowQuit = true;
        app.quit();
      });
  });
  app.whenReady().then(initialize).catch((error) => {
    console.error(error);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    const message = error?.code === 'DATA_DIRECTORY_NOT_WRITABLE'
      ? '程序同级 data 目录不可写，请将完整程序文件夹移动到可写位置后重试。'
      : '程序启动时遇到问题，请重新启动；若问题持续，请重新解压完整程序文件夹。';
    dialog.showErrorBox('图文阅读器启动失败', message);
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && library && !appExiting) createWindow(library.state.settings);
    else focusMainWindow();
  });
}

module.exports = { resolveDataDir, defaultWindowBounds };
