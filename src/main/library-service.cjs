const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { FORMAT_BY_EXTENSION, normalizePathKey, isPathWithinRoot, extensionOf } = require('./constants.cjs');
const { AppError } = require('./app-error.cjs');
const {
  sanitizeCollection,
  sanitizeArchivePosition,
  cleanName,
  cleanRoots,
  cleanFiles,
  sanitizeSettings,
  sanitizeState
} = require('./collection-store.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicCollection(collection) {
  return {
    ...collection,
    roots: [...collection.roots],
    ...(collection.files ? { files: [...collection.files] } : {})
  };
}

function bookIdForPath(filePath) {
  return crypto.createHash('sha256').update(normalizePathKey(filePath)).digest('hex');
}

function toPublicBook(filePath, stat, roots) {
  const extension = extensionOf(filePath);
  const matchingRoot = roots.find((root) => isPathWithinRoot(filePath, root));
  return {
    id: bookIdForPath(filePath),
    name: path.basename(filePath),
    relativePath: matchingRoot ? path.relative(matchingRoot, filePath) : path.basename(filePath),
    extension: extension.slice(1),
    type: FORMAT_BY_EXTENSION[extension],
    size: stat.size,
    modifiedAt: stat.mtimeMs
  };
}

function cleanFileBaseName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 200) {
    throw new AppError('INVALID_BOOK_NAME', '文件名不能为空且不能超过 200 个字符。');
  }
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..') {
    throw new AppError('INVALID_BOOK_NAME', '文件名包含 Windows 不允许使用的字符。');
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new AppError('INVALID_BOOK_NAME', '该名称是 Windows 保留名称，请换一个名称。');
  }
  return name;
}

class LibraryService {
  constructor(store) {
    this.store = store;
    this.renameRecoveryPath = path.join(store.dataDir, 'rename-recovery.json');
    this.pendingRenameRecovery = null;
    this.state = null;
    this.collections = [];
    this.booksByCollection = new Map();
    this.bookRegistry = new Map();
    this.temporaryBooks = new Map();
    this.temporaryStates = new Map();
    this.scanCoverageByCollection = new Map();
    this.scanRevisionByCollection = new Map();
    this.saveChain = Promise.resolve();
    this.topologyRevision = 0;
    this.recoveryMode = false;
  }

  async initialize() {
    this.state = await this.store.load();
    await this.recoverPendingRename();
    this.collections = this.state.collections;
    this.recoveryMode = Boolean(this.pendingRenameRecovery);
    return this.getCollections();
  }

  activateRecoveryMode(state) {
    this.state = sanitizeState(state);
    this.collections = this.state.collections;
    this.booksByCollection.clear();
    this.bookRegistry.clear();
    this.temporaryBooks.clear();
    this.temporaryStates.clear();
    this.scanCoverageByCollection.clear();
    this.scanRevisionByCollection.clear();
    this.invalidateScans();
    this.recoveryMode = true;
  }

  isRecoveryMode() {
    return this.recoveryMode;
  }

  getPendingRenameRecovery() {
    return this.pendingRenameRecovery ? clone(this.pendingRenameRecovery) : null;
  }

  getCollections() {
    return this.collections.map(publicCollection);
  }

  getPersistentSnapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async addCollection(name, roots, files = []) {
    if (this.collections.length >= 100) {
      throw new AppError('TOO_MANY_COLLECTIONS', '合集数量不能超过 100 个。');
    }
    const collection = sanitizeCollection({ name, roots, files }, false);
    this.ensureUniqueName(collection.name);
    await this.validateRoots(collection.roots);
    return this.transaction((nextState) => {
      if (nextState.collections.length >= 100) {
        throw new AppError('TOO_MANY_COLLECTIONS', '合集数量不能超过 100 个。');
      }
      this.ensureUniqueName(collection.name, null, nextState.collections);
      nextState.collections.push(collection);
      nextState.settings.activeCollectionId = collection.id;
      return publicCollection(collection);
    }, { invalidatesScans: true });
  }

  async renameCollection(id, name) {
    const cleaned = cleanName(name);
    this.ensureUniqueName(cleaned, id);
    return this.transaction((nextState) => {
      const collection = this.requireCollectionFrom(nextState.collections, id);
      this.ensureUniqueName(cleaned, id, nextState.collections);
      collection.name = cleaned;
      return publicCollection(collection);
    });
  }

  async replaceRoots(id, roots) {
    const collection = this.requireCollection(id);
    const cleaned = cleanRoots(roots, Boolean(collection.files?.length));
    await this.validateRoots(cleaned);
    const updated = await this.transaction((nextState) => {
      const target = this.requireCollectionFrom(nextState.collections, id);
      target.roots = cleaned;
      this.removeUnreferencedRecords(nextState);
      return publicCollection(target);
    }, { invalidatesScans: true });
    this.booksByCollection.delete(id);
    this.scanCoverageByCollection.delete(id);
    this.scanRevisionByCollection.delete(id);
    this.rebuildRegistry();
    return updated;
  }

  async updateCollection(id, name, roots, files = undefined) {
    const collection = this.requireCollection(id);
    const cleanedName = cleanName(name);
    const cleanedFiles = files === undefined ? [...(collection.files || [])] : cleanFiles(files);
    const cleanedRoots = cleanRoots(roots, cleanedFiles.length > 0);
    if (cleanedRoots.length === 0 && cleanedFiles.length === 0) {
      throw new AppError('INVALID_ROOTS', '合集至少需要一个目录或文件。');
    }
    this.ensureUniqueName(cleanedName, id);
    await this.validateRoots(cleanedRoots);
    const updated = await this.transaction((nextState) => {
      const target = this.requireCollectionFrom(nextState.collections, id);
      this.ensureUniqueName(cleanedName, id, nextState.collections);
      target.name = cleanedName;
      target.roots = cleanedRoots;
      if (cleanedFiles.length > 0) target.files = cleanedFiles;
      else delete target.files;
      this.removeUnreferencedRecords(nextState);
      return publicCollection(target);
    }, { invalidatesScans: true });
    this.booksByCollection.delete(id);
    this.scanCoverageByCollection.delete(id);
    this.scanRevisionByCollection.delete(id);
    this.rebuildRegistry();
    return updated;
  }

  async removeCollection(id) {
    await this.transaction((nextState) => {
      const index = nextState.collections.findIndex((item) => item.id === id);
      if (index === -1) throw new AppError('COLLECTION_NOT_FOUND', '合集不存在。');
      nextState.collections.splice(index, 1);
      if (nextState.settings.activeCollectionId === id) {
        nextState.settings.activeCollectionId = nextState.collections[0]?.id || null;
      }
      this.removeUnreferencedRecords(nextState);
    }, { invalidatesScans: true });
    this.booksByCollection.delete(id);
    this.scanCoverageByCollection.delete(id);
    this.scanRevisionByCollection.delete(id);
    this.rebuildRegistry();
    return this.getCollections();
  }

  installReplacementState(state) {
    this.state = sanitizeState(state);
    this.collections = this.state.collections;
    this.booksByCollection.clear();
    this.bookRegistry.clear();
    this.temporaryBooks.clear();
    this.temporaryStates.clear();
    this.scanCoverageByCollection.clear();
    this.scanRevisionByCollection.clear();
    this.invalidateScans();
    this.recoveryMode = false;
  }

  async importState(sourcePath) {
    return this.queueOperation(async () => {
      const content = await fs.readFile(sourcePath, 'utf8');
      const state = this.store.parse(content);
      await this.store.save(state);
      this.installReplacementState(state);
      return this.getPersistentSnapshot();
    });
  }

  async replaceState(state) {
    this.installReplacementState(state);
    return this.getCollections();
  }

  async resetAll() {
    return this.queueOperation(async () => {
      const state = await this.store.reset();
      this.installReplacementState(state);
      return this.getPersistentSnapshot();
    });
  }

  async validateRootSelection(roots) {
    const cleaned = cleanRoots(roots);
    await this.validateRoots(cleaned);
    return cleaned;
  }

  async validateSelection(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new AppError('INVALID_SELECTION', '至少选择一个文件或目录。');
    }
    const files = [];
    const roots = [];
    for (const selectedPath of paths) {
      if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
        throw new AppError('INVALID_SELECTION', '所选路径无效。');
      }
      const resolved = path.resolve(selectedPath);
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch {
        throw new AppError('PATH_NOT_AVAILABLE', `所选路径不可访问：${resolved}`);
      }
      if (stat.isDirectory()) roots.push(resolved);
      else if (stat.isFile()) {
        if (!FORMAT_BY_EXTENSION[extensionOf(resolved)]) {
          throw new AppError('UNSUPPORTED_FILE', `不支持的文件格式：${path.basename(resolved)}`);
        }
        files.push(resolved);
      } else {
        throw new AppError('INVALID_SELECTION', `所选路径不是文件或目录：${resolved}`);
      }
    }
    const cleanedRoots = cleanRoots(roots, files.length > 0);
    const cleanedFiles = cleanFiles(files);
    if (cleanedRoots.length === 0 && cleanedFiles.length === 0) {
      throw new AppError('INVALID_SELECTION', '至少选择一个文件或目录。');
    }
    return { roots: cleanedRoots, files: cleanedFiles };
  }

  getFavorites(collectionId) {
    const collection = this.requireCollection(collectionId);
    const availableBooks = new Map((this.booksByCollection.get(collectionId) || []).map((book) => [book.id, book]));
    const explicitFiles = new Set((collection.files || []).map((file) => normalizePathKey(file)));
    const groups = { comic: [], novel: [] };

    for (const [id, persistent] of Object.entries(this.state.bookStates)) {
      const extension = extensionOf(persistent.path);
      const type = FORMAT_BY_EXTENSION[extension];
      if (!type || persistent.likeCount <= 0) continue;
      const pathKey = normalizePathKey(persistent.path);
      if (!explicitFiles.has(pathKey) && !collection.roots.some((root) => isPathWithinRoot(persistent.path, root))) continue;
      const availableBook = availableBooks.get(id);
      const group = ['text', 'epub'].includes(type) ? groups.novel : groups.comic;
      group.push({
        id,
        name: availableBook?.name || path.basename(persistent.path),
        path: persistent.path,
        type,
        likeCount: persistent.likeCount,
        available: Boolean(availableBook)
      });
    }

    const rank = (items) => items.sort((a, b) => (
      b.likeCount - a.likeCount || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.path.localeCompare(b.path)
    )).slice(0, 10);
    return { comic: rank(groups.comic), novel: rank(groups.novel) };
  }

  async scanAll(onProgress = () => {}) {
    const scanRevision = this.topologyRevision;
    const scannedCollectionIds = this.collections.map((collection) => collection.id);
    const previousRuntime = this.captureScanRuntime();
    try {
      const results = [];
      for (let index = 0; index < this.collections.length; index += 1) {
        const collection = this.collections[index];
        onProgress({ phase: 'collection', index, total: this.collections.length, collectionId: collection.id, name: collection.name });
        results.push(await this.scanCollection(collection.id, onProgress, false, scanRevision));
      }
      await this.persistScanResults(results.map((result) => result.collectionId), scanRevision);
      return results;
    } catch (error) {
      if (error?.code === 'STALE_SCAN_RESULT') this.discardScanRuntime(scannedCollectionIds, scanRevision);
      else this.restoreScanRuntime(previousRuntime);
      throw error;
    }
  }

  async scanCollection(id, onProgress = () => {}, shouldPersist = true, scanRevision = this.topologyRevision) {
    const collection = this.requireCollection(id);
    const found = new Map();
    const errors = [];
    let scannedDirectories = 0;
    const rootComplete = new Map();
    const fileComplete = new Map();

    const walk = async (directory, root, status) => {
      scannedDirectories += 1;
      if (scannedDirectories % 25 === 0) {
        onProgress({ phase: 'directory', collectionId: id, scannedDirectories, path: directory });
      }
      let handle;
      try {
        handle = await fs.opendir(directory);
      } catch (error) {
        status.complete = false;
        errors.push({ path: directory, message: error.message });
        return;
      }
      try {
        for await (const entry of handle) {
          if (entry.isSymbolicLink()) continue;
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath, root, status);
            continue;
          }
          if (!entry.isFile()) continue;
          const extension = extensionOf(entry.name);
          if (!FORMAT_BY_EXTENSION[extension]) continue;
          try {
            const stat = await fs.stat(fullPath);
            const key = normalizePathKey(fullPath);
            if (!found.has(key)) found.set(key, { fullPath, stat, root });
          } catch (error) {
            status.complete = false;
            errors.push({ path: fullPath, message: error.message });
          }
        }
      } catch (error) {
        status.complete = false;
        errors.push({ path: directory, message: error.message });
      }
    };

    for (const root of collection.roots) {
      const status = { complete: true };
      await walk(root, root, status);
      rootComplete.set(normalizePathKey(root), status.complete);
    }
    for (const filePath of collection.files || []) {
      const fileKey = normalizePathKey(filePath);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          fileComplete.set(fileKey, true);
          continue;
        }
        const extension = extensionOf(filePath);
        if (!FORMAT_BY_EXTENSION[extension]) {
          fileComplete.set(fileKey, true);
          continue;
        }
        if (!found.has(fileKey)) found.set(fileKey, { fullPath: filePath, stat, root: null });
        fileComplete.set(fileKey, true);
      } catch (error) {
        errors.push({ path: filePath, message: error.message });
        fileComplete.set(fileKey, await this.isConfirmedMissingFile(filePath, error));
      }
    }

    const books = [...found.values()]
      .map(({ fullPath, stat }) => {
        const publicBook = toPublicBook(fullPath, stat, collection.roots);
        return { ...publicBook, fullPath };
      })
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }));

    this.assertCurrentScan(scanRevision);
    const previousRuntime = shouldPersist ? this.captureScanRuntime() : null;
    this.booksByCollection.set(id, books);
    this.scanCoverageByCollection.set(id, { rootComplete, fileComplete });
    this.scanRevisionByCollection.set(id, scanRevision);
    this.rebuildRegistry();
    if (shouldPersist) {
      try {
        await this.persistScanResults([id], scanRevision);
      } catch (error) {
        if (error?.code === 'STALE_SCAN_RESULT') this.discardScanRuntime([id], scanRevision);
        else this.restoreScanRuntime(previousRuntime);
        throw error;
      }
    }
    onProgress({ phase: 'complete', collectionId: id, count: books.length, errors: errors.length });
    return {
      collectionId: id,
      books: books.map(({ fullPath, ...book }) => book),
      errors,
      scannedDirectories
    };
  }

  getBook(bookId) {
    const temporary = this.temporaryBooks.get(bookId);
    if (temporary) return temporary;
    const book = this.bookRegistry.get(bookId);
    if (!book) throw new AppError('BOOK_NOT_AVAILABLE', '该文件已不在当前书库，请刷新合集。');
    return book;
  }

  getBookStates() {
    return JSON.parse(JSON.stringify(this.state.bookStates));
  }

  async markOpened(bookId) {
    const book = this.getBook(bookId);
    if (book.temporary) {
      const temporaryState = this.temporaryStates.get(bookId) || { unread: true, likeCount: 0, readCount: 0 };
      temporaryState.unread = false;
      temporaryState.readCount += 1;
      this.temporaryStates.set(bookId, temporaryState);
      return { ...temporaryState };
    }
    return this.transaction((nextState) => {
      const persistent = this.requireBookStateFrom(nextState, book);
      persistent.unread = false;
      persistent.readCount += 1;
      return { ...persistent };
    });
  }

  async addLike(bookId) {
    const book = this.getBook(bookId);
    if (book.temporary) {
      const temporaryState = this.temporaryStates.get(bookId) || { unread: true, likeCount: 0, readCount: 0 };
      temporaryState.likeCount += 1;
      this.temporaryStates.set(bookId, temporaryState);
      return { ...temporaryState };
    }
    return this.transaction((nextState) => {
      const persistent = this.requireBookStateFrom(nextState, book);
      persistent.likeCount += 1;
      return { ...persistent };
    });
  }

  async resetUnread(collectionId = null) {
    const ids = new Set();
    if (collectionId) {
      this.requireCollection(collectionId);
      for (const book of this.booksByCollection.get(collectionId) || []) ids.add(book.id);
    } else {
      for (const book of this.bookRegistry.values()) ids.add(book.id);
    }
    await this.transaction((nextState) => {
      for (const id of ids) {
        if (nextState.bookStates[id]) nextState.bookStates[id].unread = true;
      }
    });
    return this.getBookStates();
  }

  async renameBook(bookId, requestedBaseName) {
    const book = this.getBook(bookId);
    const baseName = cleanFileBaseName(requestedBaseName);
    const oldPath = book.fullPath;
    const extension = path.extname(oldPath);
    const newPath = path.join(path.dirname(oldPath), `${baseName}${extension}`);
    if (newPath === oldPath) {
      return { changed: false, oldId: bookId, newId: bookId, updates: [] };
    }

    if (normalizePathKey(newPath) !== normalizePathKey(oldPath)) {
      try {
        await fs.access(newPath);
        throw new AppError('BOOK_NAME_EXISTS', '同一目录中已存在同名文件。');
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code !== 'ENOENT') throw error;
      }
    }

    const recovery = {
      version: 1,
      bookId,
      newId: bookIdForPath(newPath),
      oldPath,
      newPath
    };
    await this.writeRenameRecovery(recovery);

    if (book.temporary) {
      try {
        await fs.rename(oldPath, newPath);
        const stat = await fs.stat(newPath);
        const renamed = {
          ...toPublicBook(newPath, stat, []),
          id: bookId,
          fullPath: newPath,
          temporary: true
        };
        this.temporaryBooks.set(bookId, renamed);
        const { fullPath, ...publicBook } = renamed;
        await this.clearRenameRecovery().catch(() => {});
        return {
          changed: true,
          oldId: bookId,
          newId: bookId,
          updates: [{ collectionId: null, book: publicBook }],
          bookState: { ...(this.temporaryStates.get(bookId) || { unread: true, likeCount: 0, readCount: 0 }) },
          settings: JSON.parse(JSON.stringify(this.state.settings))
        };
      } catch (error) {
        try {
          await fs.rename(newPath, oldPath);
          await this.clearRenameRecovery();
        } catch (rollbackError) {
          throw this.renameStateInconsistent(recovery, error, rollbackError);
        }
        throw error;
      }
    }

    try {
      await fs.rename(oldPath, newPath);
    } catch (error) {
      await this.clearRenameRecovery().catch(() => {});
      throw error;
    }
    let stat;
    let newId;
    let committed;
    try {
      stat = await fs.stat(newPath);
      newId = bookIdForPath(newPath);
      committed = await this.transaction((nextState) => {
        this.applyRenameToState(nextState, { bookId, newId, oldPath, newPath }, book);
        return {
          bookState: { ...nextState.bookStates[newId] },
          settings: clone(nextState.settings)
        };
      });
    } catch (error) {
      try {
        await fs.rename(newPath, oldPath);
        await this.clearRenameRecovery();
      } catch (rollbackError) {
        throw this.renameStateInconsistent(recovery, error, rollbackError);
      }
      throw error;
    }

    await this.clearRenameRecovery().catch(() => {});

    const updates = [];
    for (const collection of this.collections) {
      const books = this.booksByCollection.get(collection.id) || [];
      if (!books.some((item) => item.id === bookId)) continue;
      const renamed = { ...toPublicBook(newPath, stat, collection.roots), fullPath: newPath };
      this.booksByCollection.set(collection.id, books.map((item) => item.id === bookId ? renamed : item));
      const { fullPath, ...publicBook } = renamed;
      updates.push({ collectionId: collection.id, book: publicBook });
    }
    this.rebuildRegistry();
    this.invalidateScans();
    for (const update of updates) this.scanRevisionByCollection.set(update.collectionId, this.topologyRevision);
    return {
      changed: true,
      oldId: bookId,
      newId,
      updates,
      bookState: committed.bookState,
      settings: committed.settings
    };
  }

  getBookArchive(bookId) {
    const archive = this.state.bookArchives?.[bookId];
    return archive ? JSON.parse(JSON.stringify(archive)) : null;
  }

  async saveBookArchive(bookId, position) {
    const book = this.getBook(bookId);
    if (!['text', 'epub', 'comic'].includes(book.type)) {
      throw new AppError('ARCHIVE_UNAVAILABLE', '当前格式不可用。');
    }
    const cleanPosition = sanitizeArchivePosition(position, book.type);
    if (book.temporary) {
      const existing = this.temporaryStates.get(bookId) || { unread: true, likeCount: 0, readCount: 0 };
      existing.archive = { type: book.type, position: cleanPosition, savedAt: Date.now() };
      this.temporaryStates.set(bookId, existing);
      return JSON.parse(JSON.stringify(existing.archive));
    }
    await this.transaction((nextState) => {
      nextState.bookArchives[book.id] = {
        path: book.fullPath,
        type: book.type,
        position: cleanPosition,
        savedAt: Date.now()
      };
    });
    return this.getBookArchive(book.id);
  }

  getTemporaryArchive(bookId) {
    const archive = this.temporaryStates.get(bookId)?.archive;
    return archive ? JSON.parse(JSON.stringify(archive)) : null;
  }

  createTemporaryBook(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new AppError('INVALID_FILE', '打开文件必须是有效的绝对路径。');
    }
    const extension = extensionOf(filePath);
    if (!FORMAT_BY_EXTENSION[extension]) throw new AppError('UNSUPPORTED_FILE', '该文件格式暂不支持。');
    const resolved = path.resolve(filePath);
    return fs.stat(resolved).then((stat) => {
      if (!stat.isFile()) throw new AppError('INVALID_FILE', '所选路径不是文件。');
      const publicBook = toPublicBook(resolved, stat, []);
      const temporary = {
        ...publicBook,
        id: `temporary-${crypto.randomUUID()}`,
        fullPath: resolved,
        temporary: true
      };
      this.temporaryBooks.set(temporary.id, temporary);
      this.temporaryStates.set(temporary.id, { unread: true, likeCount: 0, readCount: 0 });
      return { ...temporary };
    });
  }

  releaseTemporaryBook(bookId) {
    this.temporaryBooks.delete(bookId);
    this.temporaryStates.delete(bookId);
    return true;
  }

  detachBook(bookId, invalidatesScans = true) {
    const book = this.getBook(bookId);
    if (book.temporary) {
      this.releaseTemporaryBook(bookId);
      return { bookId, collectionIds: [] };
    }
    const collectionIds = [];
    for (const [collectionId, books] of this.booksByCollection) {
      if (!books.some((book) => book.id === bookId)) continue;
      this.booksByCollection.set(collectionId, books.filter((book) => book.id !== bookId));
      collectionIds.push(collectionId);
    }
    if (invalidatesScans && collectionIds.length > 0) this.invalidateScans();
    for (const collectionId of collectionIds) this.scanRevisionByCollection.set(collectionId, this.topologyRevision);
    this.rebuildRegistry();
    return { bookId, collectionIds };
  }

  collectionIdsForBook(bookId) {
    return [...this.booksByCollection.entries()]
      .filter(([, books]) => books.some((book) => book.id === bookId))
      .map(([collectionId]) => collectionId);
  }

  async finalizeTrashedBook(bookId) {
    const book = this.getBook(bookId);
    if (book.temporary) {
      this.releaseTemporaryBook(bookId);
      return { bookId, collectionIds: [] };
    }
    await this.transaction((nextState) => this.removeBookRecords(nextState, bookId), { invalidatesScans: true });
    return this.detachBook(bookId, false);
  }

  async updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new AppError('INVALID_SETTINGS', '界面设置格式无效。');
    }
    return this.transaction((nextState) => {
      const current = nextState.settings;
      const merged = {
        ...current,
        ...patch,
        readerMode: { ...current.readerMode, ...(patch.readerMode || {}) },
        fitMode: { ...current.fitMode, ...(patch.fitMode || {}) },
        zoomScale: { ...current.zoomScale, ...(patch.zoomScale || {}) },
        novel: { ...current.novel, ...(patch.novel || {}) },
        textEncodings: Object.hasOwn(patch, 'textEncodings') ? patch.textEncodings : current.textEncodings
      };
      nextState.settings = sanitizeSettings(merged);
      return clone(nextState.settings);
    });
  }

  requireCollection(id) {
    return this.requireCollectionFrom(this.collections, id);
  }

  requireCollectionFrom(collections, id) {
    const collection = collections.find((item) => item.id === id);
    if (!collection) throw new AppError('COLLECTION_NOT_FOUND', '合集不存在。');
    return collection;
  }

  ensureUniqueName(name, ignoredId = null, collections = this.collections) {
    const key = name.toLocaleLowerCase('zh-CN');
    if (collections.some((item) => item.id !== ignoredId && item.name.toLocaleLowerCase('zh-CN') === key)) {
      throw new AppError('DUPLICATE_COLLECTION_NAME', `合集名称“${name}”已存在。`);
    }
  }

  async validateRoots(roots) {
    for (const root of roots) {
      let stat;
      try {
        stat = await fs.stat(root);
      } catch {
        throw new AppError('ROOT_NOT_AVAILABLE', `目录不可访问：${root}`);
      }
      if (!stat.isDirectory()) throw new AppError('ROOT_NOT_DIRECTORY', `所选路径不是目录：${root}`);
    }
  }

  rebuildRegistry() {
    this.bookRegistry.clear();
    for (const books of this.booksByCollection.values()) {
      for (const book of books) {
        if (!this.bookRegistry.has(book.id)) this.bookRegistry.set(book.id, book);
      }
    }
  }

  captureScanRuntime() {
    return {
      booksByCollection: new Map(
        [...this.booksByCollection].map(([collectionId, books]) => [collectionId, [...books]])
      ),
      scanCoverageByCollection: new Map(
        [...this.scanCoverageByCollection].map(([collectionId, coverage]) => [collectionId, {
          rootComplete: new Map(coverage.rootComplete),
          fileComplete: new Map(coverage.fileComplete)
        }])
      ),
      scanRevisionByCollection: new Map(this.scanRevisionByCollection)
    };
  }

  restoreScanRuntime(snapshot) {
    if (!snapshot) return;
    this.booksByCollection = snapshot.booksByCollection;
    this.scanCoverageByCollection = snapshot.scanCoverageByCollection;
    this.scanRevisionByCollection = snapshot.scanRevisionByCollection;
    this.rebuildRegistry();
  }

  discardScanRuntime(collectionIds, scanRevision) {
    for (const collectionId of collectionIds) {
      if (this.scanRevisionByCollection.get(collectionId) !== scanRevision) continue;
      this.booksByCollection.delete(collectionId);
      this.scanCoverageByCollection.delete(collectionId);
      this.scanRevisionByCollection.delete(collectionId);
    }
    this.rebuildRegistry();
  }

  invalidateScans() {
    this.topologyRevision += 1;
  }

  assertCurrentScan(scanRevision) {
    if (scanRevision !== this.topologyRevision) {
      throw new AppError('STALE_SCAN_RESULT', '书库在扫描期间已发生变化，本次扫描结果已丢弃。');
    }
  }

  requireBookStateFrom(state, book) {
    if (!state.bookStates[book.id]) {
      state.bookStates[book.id] = {
        path: book.fullPath,
        unread: true,
        likeCount: 0,
        readCount: 0
      };
    }
    return state.bookStates[book.id];
  }

  applyRenameToState(state, { bookId, newId, oldPath, newPath }, book = null) {
    const persistent = state.bookStates[bookId] || (book ? this.requireBookStateFrom(state, book) : null);
    if (persistent) {
      if (newId === bookId) state.bookStates[bookId] = { ...persistent, path: newPath };
      else {
        delete state.bookStates[bookId];
        state.bookStates[newId] = { ...persistent, path: newPath };
      }
    }

    if (newId !== bookId && state.settings.textEncodings[bookId]) {
      state.settings.textEncodings[newId] = state.settings.textEncodings[bookId];
      delete state.settings.textEncodings[bookId];
    }
    if (newId !== bookId && state.bookArchives?.[bookId]) {
      state.bookArchives[newId] = { ...state.bookArchives[bookId], path: newPath };
      delete state.bookArchives[bookId];
    } else if (state.bookArchives?.[bookId]) {
      state.bookArchives[bookId].path = newPath;
    }

    for (const collection of state.collections) {
      if (collection.files?.some((file) => normalizePathKey(file) === normalizePathKey(oldPath))) {
        collection.files = collection.files.map((file) => normalizePathKey(file) === normalizePathKey(oldPath) ? newPath : file);
      }
    }
  }

  renameStateInconsistent(recovery, originalError, rollbackError) {
    return new AppError(
      'RENAME_STATE_INCONSISTENT',
      '文件已改名，但书库状态保存失败且无法自动回滚。请重启应用后刷新合集。',
      {
        oldPath: recovery.oldPath,
        newPath: recovery.newPath,
        recoveryPending: true,
        originalCode: originalError?.code || 'STATE_SAVE_FAILED',
        rollbackCode: rollbackError?.code || 'RENAME_ROLLBACK_FAILED'
      }
    );
  }

  async writeRenameRecovery(recovery) {
    const tempPath = `${this.renameRecoveryPath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(recovery)}\n`, 'utf8');
    try {
      await fs.rename(tempPath, this.renameRecoveryPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async clearRenameRecovery() {
    await fs.rm(this.renameRecoveryPath, { force: true });
  }

  async recoverPendingRename() {
    this.pendingRenameRecovery = null;
    let recovery;
    try {
      recovery = JSON.parse(await fs.readFile(this.renameRecoveryPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') this.pendingRenameRecovery = { reason: 'INVALID_RECOVERY_RECORD' };
      return;
    }
    if (!recovery || recovery.version !== 1 || typeof recovery.oldPath !== 'string' || typeof recovery.newPath !== 'string') {
      this.pendingRenameRecovery = { reason: 'INVALID_RECOVERY_RECORD' };
      return;
    }
    const exists = async (filePath) => {
      try { await fs.access(filePath); return true; } catch { return false; }
    };
    const [oldExists, newExists] = await Promise.all([exists(recovery.oldPath), exists(recovery.newPath)]);
    if (oldExists && !newExists) {
      await this.clearRenameRecovery().catch(() => {});
      return;
    }
    if (!newExists || oldExists) {
      this.pendingRenameRecovery = recovery;
      return;
    }

    const bookId = typeof recovery.bookId === 'string' ? recovery.bookId : bookIdForPath(recovery.oldPath);
    const newId = typeof recovery.newId === 'string' ? recovery.newId : bookIdForPath(recovery.newPath);
    const nextState = clone(this.state);
    this.applyRenameToState(nextState, { bookId, newId, oldPath: recovery.oldPath, newPath: recovery.newPath });
    try {
      const cleanState = sanitizeState(nextState);
      await this.store.save(cleanState);
      this.state = cleanState;
      await this.clearRenameRecovery();
    } catch (error) {
      this.pendingRenameRecovery = { ...recovery, reason: error?.code || 'STATE_SAVE_FAILED' };
    }
  }

  async resolvePendingRename(decision) {
    const recovery = this.pendingRenameRecovery;
    if (!recovery) throw new AppError('RENAME_RECOVERY_NOT_FOUND', '当前没有待处理的重命名恢复记录。');
    if (recovery.reason === 'INVALID_RECOVERY_RECORD') {
      if (decision !== 'discard-invalid') {
        throw new AppError('INVALID_RENAME_DECISION', '无效恢复记录只能清除后重新扫描。');
      }
      return this.queueOperation(async () => {
        await this.clearRenameRecovery();
        this.pendingRenameRecovery = null;
        this.recoveryMode = false;
        return { decision, rescan: true };
      });
    }
    if (!['old', 'new', 'both'].includes(decision)) {
      throw new AppError('INVALID_RENAME_DECISION', '重命名恢复选项无效。');
    }
    const isFile = async (filePath) => {
      try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
    };
    const [oldExists, newExists] = await Promise.all([isFile(recovery.oldPath), isFile(recovery.newPath)]);
    if (decision === 'old' && !oldExists) throw new AppError('RENAME_RECOVERY_PATH_MISSING', '旧路径已不存在，请选择新路径或重新扫描。');
    if (decision === 'new' && !newExists) throw new AppError('RENAME_RECOVERY_PATH_MISSING', '新路径已不存在，请选择旧路径或重新扫描。');
    if (decision === 'both' && (!oldExists || !newExists)) {
      throw new AppError('RENAME_RECOVERY_PATH_MISSING', '旧路径和新路径必须同时存在，才能保留两者并重新扫描。');
    }

    return this.queueOperation(async () => {
      const nextState = clone(this.state);
      const oldId = typeof recovery.bookId === 'string' ? recovery.bookId : bookIdForPath(recovery.oldPath);
      const newId = typeof recovery.newId === 'string' ? recovery.newId : bookIdForPath(recovery.newPath);
      if (decision === 'new') {
        this.applyRenameToState(nextState, {
          bookId: oldId,
          newId,
          oldPath: recovery.oldPath,
          newPath: recovery.newPath
        });
      } else if (decision === 'old') {
        this.applyRenameToState(nextState, {
          bookId: newId,
          newId: oldId,
          oldPath: recovery.newPath,
          newPath: recovery.oldPath
        });
      } else {
        const oldKey = normalizePathKey(recovery.oldPath);
        const newKey = normalizePathKey(recovery.newPath);
        for (const collection of nextState.collections) {
          if (!collection.files?.some((file) => {
            const key = normalizePathKey(file);
            return key === oldKey || key === newKey;
          })) continue;
          collection.files = cleanFiles([...collection.files, recovery.oldPath, recovery.newPath]);
        }
        if (!nextState.bookStates[oldId]) {
          nextState.bookStates[oldId] = { path: recovery.oldPath, unread: true, likeCount: 0, readCount: 0 };
        }
        if (!nextState.bookStates[newId]) {
          nextState.bookStates[newId] = { path: recovery.newPath, unread: true, likeCount: 0, readCount: 0 };
        }
      }
      const cleanState = sanitizeState(nextState);
      await this.store.save(cleanState);
      this.state = cleanState;
      this.collections = cleanState.collections;
      await this.clearRenameRecovery();
      this.pendingRenameRecovery = null;
      this.recoveryMode = false;
      return { decision, rescan: true };
    });
  }

  removeBookRecords(state, bookId) {
    delete state.bookStates[bookId];
    delete state.bookArchives[bookId];
    delete state.settings.textEncodings[bookId];
  }

  referencesForPath(collections, filePath) {
    const fileKey = normalizePathKey(filePath);
    const references = [];
    for (const collection of collections) {
      for (const explicitFile of collection.files || []) {
        if (normalizePathKey(explicitFile) === fileKey) {
          references.push({ collectionId: collection.id, kind: 'file', path: explicitFile });
        }
      }
      for (const root of collection.roots) {
        if (isPathWithinRoot(filePath, root)) {
          references.push({ collectionId: collection.id, kind: 'root', path: root });
        }
      }
    }
    return references;
  }

  removeUnreferencedRecords(state) {
    const ids = new Set([
      ...Object.keys(state.bookStates),
      ...Object.keys(state.bookArchives),
      ...Object.keys(state.settings.textEncodings)
    ]);
    for (const id of ids) {
      const filePath = state.bookStates[id]?.path || state.bookArchives[id]?.path || this.bookRegistry.get(id)?.fullPath;
      if (!filePath || this.referencesForPath(state.collections, filePath).length === 0) {
        this.removeBookRecords(state, id);
      }
    }
  }

  referenceWasScanned(reference, scannedIds) {
    if (!scannedIds.has(reference.collectionId)) return false;
    const coverage = this.scanCoverageByCollection.get(reference.collectionId);
    if (!coverage) return false;
    const key = normalizePathKey(reference.path);
    return reference.kind === 'root'
      ? coverage.rootComplete.get(key) === true
      : coverage.fileComplete.get(key) === true;
  }

  async persistScanResults(collectionIds, scanRevision = this.topologyRevision) {
    const scannedIds = new Set(collectionIds);
    await this.transaction((nextState) => {
      this.assertCurrentScan(scanRevision);
      for (const book of this.bookRegistry.values()) this.requireBookStateFrom(nextState, book);
      const ids = new Set([
        ...Object.keys(nextState.bookStates),
        ...Object.keys(nextState.bookArchives),
        ...Object.keys(nextState.settings.textEncodings)
      ]);
      for (const id of ids) {
        if (this.bookRegistry.has(id)) continue;
        const filePath = nextState.bookStates[id]?.path || nextState.bookArchives[id]?.path;
        if (!filePath) {
          this.removeBookRecords(nextState, id);
          continue;
        }
        const references = this.referencesForPath(nextState.collections, filePath);
        if (references.length === 0 || references.every((reference) => this.referenceWasScanned(reference, scannedIds))) {
          this.removeBookRecords(nextState, id);
        }
      }
    });
  }

  async isConfirmedMissingFile(filePath, error) {
    if (error?.code !== 'ENOENT') return false;
    try {
      return (await fs.stat(path.dirname(filePath))).isDirectory();
    } catch {
      return false;
    }
  }

  assertWritable() {
    if (this.recoveryMode) {
      throw new AppError('CONFIG_RECOVERY_REQUIRED', '配置处于保护模式，请先恢复外部备份或初始化数据。');
    }
  }

  queueOperation(operation) {
    const pending = this.saveChain.catch(() => {}).then(operation);
    this.saveChain = pending;
    return pending;
  }

  transaction(mutator, { invalidatesScans = false } = {}) {
    return this.queueOperation(async () => {
      this.assertWritable();
      const nextState = clone(this.state);
      const result = await mutator(nextState);
      const cleanState = sanitizeState(nextState);
      await this.store.save(cleanState);
      this.state = cleanState;
      this.collections = cleanState.collections;
      if (invalidatesScans) this.invalidateScans();
      return result;
    });
  }

  persist() {
    return this.queueOperation(async () => {
      this.assertWritable();
      const cleanState = sanitizeState(clone(this.state));
      await this.store.save(cleanState);
      this.state = cleanState;
      this.collections = cleanState.collections;
    });
  }
}

module.exports = { LibraryService, bookIdForPath, toPublicBook, cleanFileBaseName };
