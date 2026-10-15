const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('./app-error.cjs');
const { normalizePathKey } = require('./constants.cjs');

const CONFIG_VERSION = 1;
const MAX_COLLECTIONS = 100;
const MAX_ROOTS = 50;
const MAX_FILES = 50_000;
const MAX_BOOK_STATES = 200_000;
const MAX_BOOK_ARCHIVES = 200_000;
const MAX_TEXT_ENCODINGS = 20_000;
const DEFAULT_SETTINGS = Object.freeze({
  activeCollectionId: null,
  readerMode: Object.freeze({ comic: 'continuous', pdf: 'continuous' }),
  fitMode: Object.freeze({ comic: 'width', pdf: 'width' }),
  zoomScale: Object.freeze({ comic: 100, pdf: 100 }),
  quickGestures: true,
  theme: 'dark',
  novel: Object.freeze({ eyeCare: true, fontScale: 100 }),
  sidebarCollapsed: false,
  textEncodings: Object.freeze({})
});

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80) {
    throw new AppError('INVALID_COLLECTION_NAME', '合集名称不能为空且不能超过 80 个字符。');
  }
  return name;
}

function cleanRoots(value, allowEmpty = false) {
  if (value === undefined && allowEmpty) return [];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_ROOTS) {
    throw new AppError('INVALID_ROOTS', `每个合集需要 1 至 ${MAX_ROOTS} 个目录。`);
  }
  const unique = new Map();
  for (const root of value) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new AppError('INVALID_ROOT', '合集目录必须是有效的绝对路径。');
    }
    const resolved = path.resolve(root);
    const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
    unique.set(key, resolved);
  }
  return [...unique.values()];
}

function cleanFiles(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILES) {
    throw new AppError('INVALID_FILES', `文件型合集不能超过 ${MAX_FILES} 个文件。`);
  }
  const unique = new Map();
  for (const file of value) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      throw new AppError('INVALID_FILE', '合集文件必须是有效的绝对路径。');
    }
    const resolved = path.resolve(file);
    const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
    unique.set(key, resolved);
  }
  return [...unique.values()];
}

function sanitizeCollection(input, keepId = true) {
  if (!input || typeof input !== 'object') {
    throw new AppError('INVALID_COLLECTION', '合集数据格式无效。');
  }
  let id = crypto.randomUUID();
  if (keepId) {
    if (
      typeof input.id !== 'string'
      || input.id.length === 0
      || input.id.length > 100
      || input.id !== input.id.trim()
    ) {
      throw new AppError('INVALID_COLLECTION_ID', '合集标识不能为空、不能包含首尾空白且不能超过 100 个字符。');
    }
    id = input.id;
  }
  const files = cleanFiles(input.files);
  const roots = cleanRoots(input.roots, files.length > 0);
  if (roots.length === 0 && files.length === 0) {
    throw new AppError('INVALID_ROOTS', '合集至少需要一个目录或文件。');
  }
  return {
    id,
    name: cleanName(input.name),
    roots,
    ...(files.length > 0 ? { files } : {})
  };
}

function validateUniqueNames(collections) {
  const names = new Set();
  for (const collection of collections) {
    const key = collection.name.toLocaleLowerCase('zh-CN');
    if (names.has(key)) {
      throw new AppError('DUPLICATE_COLLECTION_NAME', `合集名称“${collection.name}”已存在。`);
    }
    names.add(key);
  }
}

function validateUniqueIds(collections) {
  const ids = new Set();
  for (const collection of collections) {
    if (ids.has(collection.id)) {
      throw new AppError('DUPLICATE_COLLECTION_ID', '备份中的合集标识存在冲突，当前数据未被覆盖。');
    }
    ids.add(collection.id);
  }
}

function cleanCounter(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function bookIdForStoredPath(filePath) {
  return crypto.createHash('sha256').update(normalizePathKey(filePath)).digest('hex');
}

function sanitizeBookStates(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_BOOK_STATES', '书籍状态格式无效。');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_BOOK_STATES) {
    throw new AppError('TOO_MANY_BOOK_STATES', `书籍状态不能超过 ${MAX_BOOK_STATES} 条。`);
  }
  const result = {};
  for (const [id, state] of entries) {
    if (!/^[a-f0-9]{64}$/.test(id) || !state || typeof state !== 'object') {
      throw new AppError('INVALID_BOOK_STATE', '书籍状态条目无效。');
    }
    if (typeof state.path !== 'string' || !path.isAbsolute(state.path) || bookIdForStoredPath(state.path) !== id) {
      throw new AppError('INVALID_BOOK_PATH', '书籍状态路径与标识不匹配。');
    }
    result[id] = {
      path: path.resolve(state.path),
      unread: state.unread !== false,
      likeCount: cleanCounter(state.likeCount),
      readCount: cleanCounter(state.readCount)
    };
  }
  return result;
}

function sanitizeArchivePosition(value, type) {
  if (!value || typeof value !== 'object') {
    throw new AppError('INVALID_BOOK_ARCHIVE', '小说存档位置格式无效。');
  }
  if (type === 'text' && value.kind === 'scroll') {
    const cleanScroll = (candidate) => Number.isFinite(Number(candidate))
      ? Math.max(0, Math.min(1_000_000_000, Number(candidate)))
      : 0;
    return {
      kind: 'scroll',
      scrollTop: cleanScroll(value.scrollTop),
      scrollLeft: cleanScroll(value.scrollLeft)
    };
  }
  if (type === 'epub' && value.kind === 'epub' && typeof value.cfi === 'string' && value.cfi.length > 4000) {
    throw new AppError('INVALID_BOOK_ARCHIVE', 'EPUB 存档定位过长。');
  }
  if (type === 'epub' && value.kind === 'epub' && typeof value.cfi === 'string' && value.cfi.trim()) {
    return { kind: 'epub', cfi: value.cfi.trim() };
  }
  if (type === 'comic') {
    const pageIndex = Number.isFinite(Number(value.pageIndex))
      ? Math.max(0, Math.min(1_000_000, Math.trunc(Number(value.pageIndex))))
      : 0;
    const ratio = (candidate) => Number.isFinite(Number(candidate))
      ? Math.max(0, Math.min(1, Number(candidate)))
      : 0;
    const fitMode = ['width', 'height', 'fit'].includes(value.fitMode)
      ? value.fitMode
      : value.mode === 'page' ? 'height' : 'width';
    const zoomScale = Number.isFinite(Number(value.zoomScale))
      ? Math.min(300, Math.max(50, Math.round(Number(value.zoomScale) / 10) * 10))
      : 100;
    if (value.mode === 'page' && value.kind === 'page') {
      return {
        kind: 'page',
        mode: 'page',
        pageIndex,
        fitMode,
        zoomScale,
        scrollTopRatio: ratio(value.scrollTopRatio),
        scrollLeftRatio: ratio(value.scrollLeftRatio)
      };
    }
    if (value.mode === 'continuous' && value.kind === 'continuous-page') {
      return {
        kind: 'continuous-page',
        mode: 'continuous',
        pageIndex,
        fitMode,
        zoomScale,
        offsetRatio: ratio(value.offsetRatio),
        scrollLeftRatio: ratio(value.scrollLeftRatio)
      };
    }
  }
  throw new AppError('INVALID_BOOK_ARCHIVE', '存档位置与文件类型不匹配。');
}

function sanitizeBookArchives(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_BOOK_ARCHIVES', '小说存档格式无效。');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_BOOK_ARCHIVES) {
    throw new AppError('TOO_MANY_BOOK_ARCHIVES', `小说存档不能超过 ${MAX_BOOK_ARCHIVES} 条。`);
  }
  const result = {};
  for (const [id, archive] of entries) {
    if (!/^[a-f0-9]{64}$/.test(id) || !archive || typeof archive !== 'object') {
      throw new AppError('INVALID_BOOK_ARCHIVE', '小说存档条目无效。');
    }
    if (typeof archive.path !== 'string' || !path.isAbsolute(archive.path) || bookIdForStoredPath(archive.path) !== id) {
      throw new AppError('INVALID_BOOK_PATH', '小说存档路径与标识不匹配。');
    }
    if (!['text', 'epub', 'comic'].includes(archive.type)) {
      throw new AppError('INVALID_BOOK_ARCHIVE', '存档类型无效。');
    }
    const savedAt = Number(archive.savedAt);
    result[id] = {
      path: path.resolve(archive.path),
      type: archive.type,
      position: sanitizeArchivePosition(archive.position, archive.type),
      savedAt: Number.isFinite(savedAt) ? Math.max(0, Math.min(8_640_000_000_000_000, Math.round(savedAt))) : Date.now()
    };
  }
  return result;
}

function sanitizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const readerMode = source.readerMode && typeof source.readerMode === 'object' ? source.readerMode : {};
  const fitMode = source.fitMode && typeof source.fitMode === 'object' ? source.fitMode : {};
  const zoomScale = source.zoomScale && typeof source.zoomScale === 'object' ? source.zoomScale : {};
  const encodings = source.textEncodings && typeof source.textEncodings === 'object' && !Array.isArray(source.textEncodings)
    ? source.textEncodings
    : {};
  const encodingEntries = Object.entries(encodings);
  if (encodingEntries.length > MAX_TEXT_ENCODINGS) {
    throw new AppError('TOO_MANY_ENCODING_SETTINGS', `TXT 编码设置不能超过 ${MAX_TEXT_ENCODINGS} 条。`);
  }
  const textEncodings = {};
  for (const [id, encoding] of encodingEntries) {
    if (/^[a-f0-9]{64}$/.test(id) && ['utf8', 'gb18030', 'big5'].includes(encoding)) {
      textEncodings[id] = encoding;
    }
  }
  return {
    activeCollectionId: typeof source.activeCollectionId === 'string' ? source.activeCollectionId : null,
    readerMode: {
      comic: source.readerMode?.comic === 'page' ? 'page' : 'continuous',
      pdf: source.readerMode?.pdf === 'page' ? 'page' : 'continuous'
    },
    fitMode: {
      comic: 'width',
      pdf: ['width', 'height', 'fit'].includes(fitMode.pdf) ? fitMode.pdf : 'width'
    },
    zoomScale: {
      comic: 100,
      pdf: Number.isFinite(zoomScale.pdf)
        ? Math.min(300, Math.max(50, Math.round(zoomScale.pdf / 10) * 10))
        : 100
    },
    quickGestures: source.quickGestures !== false,
    theme: source.theme === 'light' ? 'light' : 'dark',
    novel: {
      eyeCare: source.novel && Object.hasOwn(source.novel, 'eyeCare')
        ? source.novel.eyeCare === true
        : DEFAULT_SETTINGS.novel.eyeCare,
      fontScale: Number.isInteger(source.novel?.fontScale)
        ? Math.min(200, Math.max(70, Math.round(source.novel.fontScale / 10) * 10))
        : 100
    },
    sidebarCollapsed: source.sidebarCollapsed === true,
    textEncodings
  };
}

function sanitizeState(value) {
  if (!value || typeof value !== 'object') {
    throw new AppError('INVALID_STATE', '状态文件格式无效。');
  }
  if (value.version !== CONFIG_VERSION || !Array.isArray(value.collections)) {
    throw new AppError('UNSUPPORTED_BACKUP', '状态文件版本不受支持。');
  }
  if (value.collections.length > MAX_COLLECTIONS) {
    throw new AppError('TOO_MANY_COLLECTIONS', `合集数量不能超过 ${MAX_COLLECTIONS} 个。`);
  }
  const collections = value.collections.map((item) => sanitizeCollection(item, true));
  validateUniqueIds(collections);
  validateUniqueNames(collections);
  const settings = sanitizeSettings(value.settings);
  if (settings.activeCollectionId && !collections.some((item) => item.id === settings.activeCollectionId)) {
    settings.activeCollectionId = collections[0]?.id || null;
  }
  return {
    version: CONFIG_VERSION,
    collections,
    bookStates: sanitizeBookStates(value.bookStates),
    bookArchives: sanitizeBookArchives(value.bookArchives),
    settings
  };
}

function createDefaultState() {
  return sanitizeState({ version: CONFIG_VERSION, collections: [], bookStates: {}, settings: DEFAULT_SETTINGS });
}

class CollectionStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'state.json');
    this.backupPath = path.join(dataDir, 'state.json.bak');
    this.writeChain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let primaryError = null;
    try {
      const content = await fs.readFile(this.configPath, 'utf8');
      return this.parse(content);
    } catch (error) {
      primaryError = error;
    }

    try {
      const backup = await fs.readFile(this.backupPath, 'utf8');
      const recovered = this.parse(backup);
      await this.rebuildPrimary(recovered, primaryError);
      return recovered;
    } catch (backupError) {
      if (primaryError?.code === 'ENOENT' && backupError?.code === 'ENOENT') return createDefaultState();
      throw new AppError('COLLECTION_CONFIG_BROKEN', '合集配置和安全备份均无法读取，请恢复外部备份或初始化数据。');
    }
  }

  async rebuildPrimary(state, primaryError) {
    let corruptPath = null;
    if (primaryError?.code !== 'ENOENT') {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
      corruptPath = `${this.configPath}.corrupt-${stamp}`;
      await fs.rename(this.configPath, corruptPath);
    }
    try {
      await this.writePrimary(this.serialize(state));
    } catch (error) {
      if (corruptPath) await fs.rename(corruptPath, this.configPath).catch(() => {});
      throw error;
    }
  }

  parse(content) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError('INVALID_BACKUP', '合集文件不是有效的 JSON。');
    }
    return sanitizeState(parsed);
  }

  serialize(state) {
    return `${JSON.stringify(sanitizeState(state), null, 2)}\n`;
  }

  enqueueWrite(operation) {
    const pending = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = pending;
    return pending;
  }

  async writePrimary(content) {
    const tempPath = `${this.configPath}.tmp`;
    try {
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, this.configPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async writeState(content) {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const current = await fs.readFile(this.configPath, 'utf8');
      this.parse(current);
      const backupTempPath = `${this.backupPath}.tmp`;
      try {
        await fs.copyFile(this.configPath, backupTempPath);
        await fs.rename(backupTempPath, this.backupPath);
      } catch (error) {
        await fs.rm(backupTempPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof AppError)) throw error;
    }
    await this.writePrimary(content);
  }

  save(state) {
    const content = this.serialize(state);
    return this.enqueueWrite(() => this.writeState(content));
  }

  async exportTo(targetPath, state) {
    await fs.writeFile(targetPath, this.serialize(state), 'utf8');
  }

  async importFrom(sourcePath) {
    const content = await fs.readFile(sourcePath, 'utf8');
    const state = this.parse(content);
    await this.save(state);
    return state;
  }

  async reset() {
    const state = createDefaultState();
    const content = this.serialize(state);
    await this.enqueueWrite(async () => {
      await fs.rm(this.configPath, { force: true });
      await fs.rm(this.backupPath, { force: true });
      await fs.rm(`${this.configPath}.tmp`, { force: true });
      await fs.rm(`${this.backupPath}.tmp`, { force: true });
      await fs.rm(path.join(this.dataDir, 'cache'), { recursive: true, force: true });
      await fs.mkdir(this.dataDir, { recursive: true });
      await this.writePrimary(content);
    });
    return state;
  }
}

module.exports = {
  CollectionStore,
  CONFIG_VERSION,
  DEFAULT_SETTINGS,
  createDefaultState,
  sanitizeState,
  sanitizeSettings,
  sanitizeBookStates,
  sanitizeBookArchives,
  sanitizeArchivePosition,
  sanitizeCollection,
  cleanName,
  cleanRoots,
  cleanFiles
};
