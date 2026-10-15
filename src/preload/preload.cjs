const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response?.ok) return response.data;
  const error = new Error(response?.error?.message || '操作失败。');
  error.code = response?.error?.code || 'UNKNOWN_ERROR';
  error.details = response?.error?.details;
  throw error;
}

contextBridge.exposeInMainWorld('readerApi', Object.freeze({
  getState: () => invoke('collections:get'),
  resolveRenameRecovery: (decision) => invoke('library:resolve-rename-recovery', decision),
  selectRoots: () => invoke('collections:select-roots'),
  selectPaths: () => invoke('collections:select-paths'),
  validateRoots: (roots) => invoke('collections:validate-roots', roots),
  validateSelection: (paths) => invoke('collections:validate-selection', paths),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  addCollection: (input) => invoke('collections:add', input),
  renameCollection: (input) => invoke('collections:rename', input),
  replaceRoots: (input) => invoke('collections:replace-roots', input),
  updateCollection: (input) => invoke('collections:update', input),
  removeCollection: (id) => invoke('collections:remove', id),
  scanAll: () => invoke('library:scan-all'),
  scanCollection: (id) => invoke('library:scan-one', id),
  markOpened: (bookId) => invoke('state:mark-opened', bookId),
  addLike: (bookId) => invoke('state:add-like', bookId),
  resetUnread: (collectionId) => invoke('state:reset-unread', collectionId),
  updateSettings: (patch) => invoke('state:update-settings', patch),
  getFavorites: (collectionId) => invoke('state:favorites', collectionId),
  getArchive: (bookId) => invoke('state:get-archive', bookId),
  saveArchive: (bookId, position) => invoke('state:save-archive', bookId, position),
  initializeData: () => invoke('state:initialize'),
  loadText: (bookId, encoding) => invoke('reader:load-text', bookId, encoding),
  loadBinary: (bookId, expectedType, options = {}) => invoke('reader:load-binary', bookId, expectedType, options),
  cancelBinary: (requestId) => invoke('reader:cancel-binary', requestId),
  openPdf: (bookId, sessionId) => invoke('reader:open-pdf', bookId, sessionId),
  readPdfRange: (bookId, options = {}) => invoke('reader:read-pdf-range', bookId, options),
  cancelPdf: (sessionId) => invoke('reader:cancel-pdf', sessionId),
  listArchive: (bookId, options = {}) => invoke('reader:list-archive', bookId, options),
  cancelArchiveList: (requestId) => invoke('reader:cancel-archive-list', requestId),
  openArchiveSession: (bookId, sessionId, pages) => invoke('reader:open-archive-session', bookId, sessionId, pages),
  closeArchiveSession: (sessionId) => invoke('reader:close-archive-session', sessionId),
  readArchivePage: (bookId, entryName, options = {}) => invoke('reader:read-archive-page', bookId, entryName, options),
  cancelArchivePage: (requestId) => invoke('reader:cancel-archive-page', requestId),
  renameBook: (bookId, baseName) => invoke('reader:rename-book', bookId, baseName),
  trashBook: (bookId) => invoke('reader:trash-book', bookId),
  showBookInFolder: (bookId) => invoke('reader:show-book-in-folder', bookId),
  openTemporary: (filePath) => invoke('reader:open-temporary', filePath),
  releaseTemporary: (bookId) => invoke('reader:release-temporary', bookId),
  exportBackup: () => invoke('backup:export'),
  importBackup: () => invoke('backup:import'),
  getDataPath: () => invoke('app:get-data-path'),
  reportStartupProgress: (progress) => invoke('app:startup-progress', progress),
  startupComplete: () => invoke('app:startup-complete'),
  showDataFolder: () => invoke('app:show-data-folder'),
  toggleFullscreen: () => invoke('app:toggle-fullscreen'),
  setFullscreen: (value) => invoke('app:set-fullscreen', value),
  onArchiveProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('reader:archive-progress', listener);
    return () => ipcRenderer.removeListener('reader:archive-progress', listener);
  },
  onFullscreenChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value === true);
    ipcRenderer.on('app:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('app:fullscreen-changed', listener);
  },
  onScanProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('library:scan-progress', listener);
    return () => ipcRenderer.removeListener('library:scan-progress', listener);
  }
}));
