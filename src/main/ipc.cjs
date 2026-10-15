const path = require('node:path');
const { dialog, ipcMain, shell } = require('electron');
const { publicError, AppError } = require('./app-error.cjs');

function register(ipcChannel, handler) {
  ipcMain.handle(ipcChannel, async (event, ...args) => {
    try {
      return { ok: true, data: await handler(event, ...args) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  });
}

async function delayValidationForTest() {
  const delayMs = Number(process.env.RANDOM_READER_E2E_DELAY_VALIDATE_MS);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5000)));
}

function registerIpc({ library, store, reader, getWindow, dataDir, onStartupProgress = () => {}, onStartupComplete = () => {} }) {
  const archiveReadRequests = new Map();
  const archiveListRequests = new Map();
  const binaryReadRequests = new Map();
  const pdfSessions = new Map();
  const archiveReadTestAttempts = new Map();
  register('collections:get', async () => ({
    collections: library.getCollections(),
    bookStates: library.getBookStates(),
    settings: library.getPersistentSnapshot().settings,
    recoveryMode: library.isRecoveryMode(),
    pendingRenameRecovery: library.getPendingRenameRecovery()
  }));

  register('collections:select-roots', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择合集目录',
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    });
    return result.canceled ? [] : result.filePaths;
  });
  register('collections:select-paths', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择一个或多个文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '支持的图文文件', extensions: ['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7', 'txt', 'epub', 'pdf'] }]
    });
    return result.canceled ? [] : result.filePaths;
  });
  register('collections:validate-roots', async (_event, roots) => library.validateRootSelection(roots));
  register('collections:validate-selection', async (_event, paths) => {
    await delayValidationForTest();
    return library.validateSelection(paths);
  });

  register('collections:add', async (_event, input) => {
    if (!input || typeof input !== 'object') throw new AppError('INVALID_COLLECTION', '合集参数无效。');
    return library.addCollection(input.name, input.roots, input.files);
  });
  register('collections:rename', async (_event, input) => library.renameCollection(input?.id, input?.name));
  register('collections:replace-roots', async (_event, input) => library.replaceRoots(input?.id, input?.roots));
  register('collections:update', async (_event, input) => library.updateCollection(input?.id, input?.name, input?.roots, input?.files));
  register('collections:remove', async (_event, id) => library.removeCollection(id));

  const progressFor = (event) => (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('library:scan-progress', progress);
  };
  register('library:scan-all', async (event) => library.scanAll(progressFor(event)));
  register('library:scan-one', async (event, id) => library.scanCollection(id, progressFor(event)));

  register('state:mark-opened', async (_event, bookId) => library.markOpened(bookId));
  register('state:add-like', async (_event, bookId) => library.addLike(bookId));
  register('state:reset-unread', async (_event, collectionId) => library.resetUnread(collectionId || null));
  register('state:update-settings', async (_event, patch) => library.updateSettings(patch));
  register('state:favorites', async (_event, collectionId) => library.getFavorites(collectionId));
  register('state:get-archive', async (_event, bookId) => library.getBookArchive(bookId) || library.getTemporaryArchive(bookId));
  register('state:save-archive', async (_event, bookId, position) => library.saveBookArchive(bookId, position));
  register('state:initialize', async () => {
    await reader.shutdown();
    return library.resetAll();
  });

  register('reader:load-text', async (_event, bookId, encoding) => reader.loadText(bookId, encoding));
  register('reader:load-binary', async (event, bookId, expectedType, options) => {
    const requestId = typeof options?.requestId === 'string' && options.requestId.length <= 128
      ? options.requestId
      : null;
    const controller = new AbortController();
    const request = { controller, sender: event.sender };
    if (requestId) binaryReadRequests.set(requestId, request);
    try {
      return await reader.loadBinary(bookId, expectedType, { signal: controller.signal });
    } finally {
      if (requestId && binaryReadRequests.get(requestId) === request) binaryReadRequests.delete(requestId);
    }
  });
  register('reader:cancel-binary', async (event, requestId) => {
    if (typeof requestId !== 'string') return false;
    const request = binaryReadRequests.get(requestId);
    if (!request || request.sender !== event.sender) return false;
    request.controller.abort();
    return true;
  });
  register('reader:open-pdf', async (event, bookId, sessionId) => {
    const metadata = await reader.openPdf(bookId, sessionId);
    pdfSessions.set(sessionId, { sender: event.sender, bookId });
    return metadata;
  });
  register('reader:read-pdf-range', async (event, bookId, options) => {
    const sessionId = options?.sessionId;
    const session = pdfSessions.get(sessionId);
    if (!session || session.sender !== event.sender || session.bookId !== bookId) {
      throw new AppError('INVALID_READER_REQUEST', 'PDF 读取会话无效。');
    }
    return reader.readPdfRange(bookId, options);
  });
  register('reader:cancel-pdf', async (event, sessionId) => {
    const session = pdfSessions.get(sessionId);
    if (!session || session.sender !== event.sender) return false;
    pdfSessions.delete(sessionId);
    await reader.closePdf(sessionId);
    return true;
  });
  register('reader:list-archive', async (event, bookId, options) => {
    const requestId = typeof options?.requestId === 'string' && options.requestId.length <= 128
      ? options.requestId
      : null;
    const controller = new AbortController();
    const request = { controller, sender: event.sender };
    if (requestId) archiveListRequests.set(requestId, request);
    try {
      return await reader.listArchive(bookId, { signal: controller.signal });
    } finally {
      if (requestId && archiveListRequests.get(requestId) === request) archiveListRequests.delete(requestId);
    }
  });
  register('reader:cancel-archive-list', async (event, requestId) => {
    if (typeof requestId !== 'string') return false;
    const request = archiveListRequests.get(requestId);
    if (!request || request.sender !== event.sender) return false;
    request.controller.abort();
    return true;
  });
  register('reader:open-archive-session', async (_event, bookId, sessionId, pages) => (
    reader.openArchiveSession(bookId, sessionId, pages)
  ));
  register('reader:close-archive-session', async (_event, sessionId) => reader.closeArchiveSession(sessionId));
  register('reader:read-archive-page', async (event, bookId, entryName, options) => {
    const requestId = typeof options?.requestId === 'string' && options.requestId.length <= 128
      ? options.requestId
      : null;
    const controller = new AbortController();
    const request = { controller, sender: event.sender };
    if (requestId) archiveReadRequests.set(requestId, request);
    const reportProgress = options?.foreground === true
      ? (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('reader:archive-progress', { bookId, ...progress });
        }
      : () => {};
    try {
      const injectedFailures = Math.max(0, Math.min(10, Number(process.env.RANDOM_READER_E2E_FAIL_ARCHIVE_ATTEMPTS) || 0));
      const injectedEntry = process.env.RANDOM_READER_E2E_FAIL_ARCHIVE_ENTRY;
      if (injectedFailures > 0 && (!injectedEntry || injectedEntry === entryName)) {
        const key = `${bookId}\0${entryName}`;
        const attempt = (archiveReadTestAttempts.get(key) || 0) + 1;
        archiveReadTestAttempts.set(key, attempt);
        if (attempt <= injectedFailures) throw new AppError('ARCHIVE_TEST_FAILURE', '端到端测试注入的漫画页面读取失败。');
      }
      return await reader.readArchivePage(bookId, entryName, reportProgress, {
        sessionId: options?.sessionId,
        refresh: options?.refresh === true,
        cacheOnly: options?.cacheOnly === true,
        signal: controller.signal
      });
    } finally {
      if (requestId && archiveReadRequests.get(requestId) === request) archiveReadRequests.delete(requestId);
    }
  });
  register('reader:cancel-archive-page', async (event, requestId) => {
    if (typeof requestId !== 'string') return false;
    const request = archiveReadRequests.get(requestId);
    if (!request || request.sender !== event.sender) return false;
    request.controller.abort();
    return true;
  });
  register('reader:rename-book', async (_event, bookId, baseName) => {
    await reader.clearCaches();
    const result = await library.renameBook(bookId, baseName);
    return result;
  });
  register('library:resolve-rename-recovery', async (_event, decision) => library.resolvePendingRename(decision));
  register('reader:trash-book', async (_event, bookId) => {
    const book = library.getBook(bookId);
    const collectionIds = library.collectionIdsForBook(bookId);
    await reader.clearCaches();
    await shell.trashItem(book.fullPath);
    try {
      return await library.finalizeTrashedBook(bookId);
    } catch {
      throw new AppError(
        'TRASH_STATE_SAVE_FAILED',
        '文件已进入 Windows 回收站，但相关状态清理未能保存。',
        { fileTrashed: true, bookId, collectionIds }
      );
    }
  });
  register('reader:show-book-in-folder', async (_event, bookId) => {
    const book = library.getBook(bookId);
    shell.showItemInFolder(book.fullPath);
    return true;
  });
  register('reader:open-temporary', async (_event, filePath) => library.createTemporaryBook(filePath));
  register('reader:release-temporary', async (_event, bookId) => library.releaseTemporaryBook(bookId));

  register('backup:export', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '备份图文阅读器数据',
      defaultPath: path.join(dataDir, `图文阅读器备份_${date}.json`),
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await store.exportTo(result.filePath, library.getPersistentSnapshot());
    return { canceled: false, filePath: result.filePath };
  });

  register('backup:import', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '恢复图文阅读器数据',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const state = await library.importState(result.filePaths[0]);
    return { canceled: false, state: library.getPersistentSnapshot() };
  });

  register('app:get-data-path', async () => dataDir);
  register('app:startup-progress', async (_event, progress) => {
    if (!progress || typeof progress !== 'object') return false;
    onStartupProgress(progress);
    return true;
  });
  register('app:startup-complete', async () => {
    onStartupComplete();
    return true;
  });
  register('app:toggle-fullscreen', async () => {
    const window = getWindow();
    window.setFullScreen(!window.isFullScreen());
    return window.isFullScreen();
  });
  register('app:set-fullscreen', async (_event, value) => {
    getWindow().setFullScreen(value === true);
    return getWindow().isFullScreen();
  });
  register('app:show-data-folder', async () => {
    const { shell } = require('electron');
    const error = await shell.openPath(path.resolve(dataDir));
    if (error) throw new AppError('OPEN_DATA_FOLDER_FAILED', '无法打开数据目录。');
    return true;
  });
}

module.exports = { registerIpc };
