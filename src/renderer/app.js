import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookmarkCheck,
  BookmarkPlus,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePenLine,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  Heart,
  LibraryBig,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RotateCcw,
  RotateCw,
  Rows3,
  Search,
  Settings,
  Shuffle,
  Square,
  Sun,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  createIcons
} from 'lucide';
import './styles.css';
import { ReaderController } from './reader-controller.js';
import { SessionHistory } from './session-history.js';
import {
  RANDOM_STRATEGIES,
  booksForRandomTab,
  selectRandomBook
} from './random-strategy.js';

const icons = Object.freeze({
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookmarkCheck,
  BookmarkPlus,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePenLine,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  Heart,
  LibraryBig,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RotateCcw,
  RotateCw,
  Rows3,
  Search,
  Settings,
  Shuffle,
  Square,
  Sun,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut
});

const state = {
  collections: [],
  scans: new Map(),
  bookStates: {},
  settings: null,
  activeCollectionId: null,
  history: new SessionHistory(),
  filter: 'all',
  filterByCollection: new Map(),
  randomStrategy: RANDOM_STRATEGIES.DEFAULT,
  successfulDraws: 0,
  search: '',
  selectedRoots: [],
  editingCollectionId: null,
  collectionDialogSessionId: 0,
  collectionSubmitRunId: 0,
  collectionSubmitting: false,
  currentBook: null,
  temporaryState: null,
  likedThisOpen: false,
  scanning: false,
  pendingRandomBookId: null,
  dragDepth: 0,
  fullscreen: false,
  openingBook: false,
  readerClosing: false,
  startupActive: true,
  recoveryMode: false,
  pendingRenameRecovery: null,
  recoveryResolving: false,
  selectingCollection: false,
  sidebarChanging: false,
  themeChanging: false
};

const elements = {};
let toolbarHideTimer = null;
let pageControlsHideTimer = null;

function cacheElements() {
  const ids = [
    'app', 'scanStatus', 'collectionList', 'activeCollectionName', 'collectionCount', 'bookTable', 'bookRows',
    'emptyState', 'drawBtn', 'addRootsBtn', 'refreshBtn', 'editCollectionBtn', 'deleteCollectionBtn', 'resetPoolBtn',
    'searchInput', 'historyList', 'addCollectionBtn', 'emptyAddBtn',
    'sidebarToggle', 'exportBtn', 'importBtn', 'favoritesBtn', 'initializeBtn', 'dataFolderBtn', 'themeToggle', 'themeToggleLabel',
    'strategyBtn', 'strategyMenu',
    'readerOverlay', 'readerToolbar', 'readerViewport', 'pageNavigation', 'readerTitle', 'readerMeta', 'readerLikeCount',
    'likeBtn', 'readerRandomBtn', 'showBookFolderBtn', 'renameBookBtn', 'trashBookBtn', 'quickGestureBtn', 'fullscreenBtn', 'closeReaderBtn',
    'collectionDialog', 'collectionForm', 'collectionDialogTitle', 'collectionNameInput', 'selectedRoots',
    'chooseFilesBtn', 'chooseRootsBtn', 'closeCollectionDialog', 'cancelCollectionBtn', 'saveCollectionBtn',
    'confirmDialog', 'confirmTitle', 'confirmMessage', 'confirmAccept', 'toastRegion',
    'favoritesDialog', 'closeFavoritesDialog', 'favoriteComicList', 'favoriteNovelList', 'dropOverlay',
    'renameDialog', 'renameForm', 'renameInput', 'renameExtension', 'closeRenameDialog', 'cancelRenameBtn', 'saveRenameBtn',
    'renameRecoveryDialog', 'renameRecoveryTitle', 'renameRecoveryMessage', 'renameRecoveryPaths', 'renameRecoveryOldPath', 'renameRecoveryNewPath',
    'renameRecoveryOldBtn', 'renameRecoveryNewBtn', 'renameRecoveryBothBtn', 'renameRecoveryDiscardBtn'
  ];
  for (const id of ids) elements[id] = document.querySelector(`#${id}`);
  elements.filterTabs = [...document.querySelectorAll('[data-filter]')];
}

function refreshIcons() {
  createIcons({ icons, attrs: { 'stroke-width': 1.8 } });
}

function setButtonIcon(button, name) {
  if (!button || button.dataset.icon === name) return;
  button.dataset.icon = name;
  const current = button.querySelector('svg, [data-lucide]');
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  if (current) current.replaceWith(icon);
  else button.prepend(icon);
}

function showToast(message, type = 'info', duration = 3600) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), duration);
}

function errorMessage(error) {
  const code = error?.code;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const suggestions = {
    PATH_NOT_AVAILABLE: '请确认路径存在且当前账户有读取权限。',
    ROOT_NOT_AVAILABLE: '请确认目录存在且当前账户有读取权限。',
    ROOT_NOT_DIRECTORY: '请选择实际目录后重试。',
    UNSUPPORTED_FILE: '请改选支持的 TXT、EPUB、PDF 或漫画压缩包。',
    BOOK_NOT_AVAILABLE: '请先刷新合集，再重新打开文件。',
    ENCRYPTED_CONTENT: '请更换未加密的文件。',
    ARCHIVE_INVALID: '请检查压缩包是否完整，或改用其他文件。',
    ARCHIVE_EMPTY: '请确认压缩包内包含可读取的图片。',
    ARCHIVE_ENTRY_TOO_LARGE: '请更换较小的图片页面。',
    ARCHIVE_ENTRY_NOT_FOUND: '请重新扫描合集后重试。',
    ARCHIVE_ENGINE_FAILED: '请重启应用后重试，或更换压缩包。',
    ARCHIVE_ERROR_OUTPUT_TOO_LARGE: '压缩包错误输出过大，可能已损坏，请更换压缩包。',
    INVALID_RECOVERY_RECORD: '重命名恢复记录已损坏，请清除无效记录后重新扫描。',
    ARCHIVE_READ_TIMEOUT: '请检查压缩包是否损坏，或更换压缩包。',
    ARCHIVE_READ_CANCELLED: '当前页面读取已取消。',
    PDF_READ_TIMEOUT: '请检查 PDF 是否完整，或稍后重试。',
    PDF_READ_CANCELLED: '当前 PDF 读取已停止。',
    PDF_RANGE_INVALID: 'PDF 读取范围无效，请重新打开文件。',
    PDF_RANGE_TOO_LARGE: 'PDF 单次读取范围过大，请重新打开文件。',
    PDF_FILE_CHANGED: 'PDF 文件已发生变化，请重新打开文件。',
    PDF_INVALID: '请检查 PDF 是否完整，或改用其他文件。',
    EPUB_READ_CANCELLED: '当前 EPUB 读取已停止。',
    TEXT_TOO_LARGE: '请改用不超过 64 MB 的 TXT 文件。',
    FILE_TOO_LARGE: '请改用不超过 512 MB 的文件。',
    UNSUPPORTED_ENCODING: '请切换到文件实际使用的编码。',
    WRONG_BOOK_TYPE: '请使用与文件格式匹配的阅读器。',
    INVALID_SELECTION: '请重新选择至少一个存在的文件或目录。',
    INVALID_ROOTS: '请保留至少一个存在的目录或文件。',
    DUPLICATE_COLLECTION_NAME: '请换用尚未使用的合集名称。',
    COLLECTION_NOT_FOUND: '请重新打开合集后再提交。',
    DUPLICATE_COLLECTION_ID: '请修正备份中的重复合集标识后重试。',
    INVALID_COLLECTION_ID: '请使用合集标识有效的备份文件。',
    BOOK_NAME_EXISTS: '请换用同一目录中尚不存在的文件名。',
    RENAME_STATE_INCONSISTENT: '文件已改名但配置尚未同步，请重启应用后再刷新合集。',
    RENAME_RECOVERY_NOT_FOUND: '当前没有待处理的重命名恢复记录。',
    INVALID_RENAME_DECISION: '请选择有效的重命名恢复方式。',
    RENAME_RECOVERY_PATH_MISSING: '所选路径已不存在，请选择另一条路径或重新扫描。',
    STALE_SCAN_RESULT: '请重新刷新当前合集。',
    ARCHIVE_UNAVAILABLE: '存档仅支持漫画、TXT 和流式 EPUB；请打开支持的格式。',
    COLLECTION_CONFIG_BROKEN: '请从有效的备份文件恢复合集配置。',
    CONFIG_RECOVERY_REQUIRED: '当前只允许恢复备份或初始化数据。',
    TRASH_STATE_SAVE_FAILED: '文件仍可从 Windows 回收站恢复；恢复配置写入能力后再刷新书库。',
    OPEN_DATA_FOLDER_FAILED: '请确认数据目录仍然存在且可访问。',
    INTERNAL_ERROR: '请重试；若问题持续，请重启应用。'
  };
  if (!message && !suggestions[code]) return '操作失败，请重试。';
  if (code === 'ARCHIVE_UNAVAILABLE') {
    const context = message && message !== '当前格式不可用。' ? `${message} ` : '当前打开的文件不可用：';
    return `${context}${suggestions[code]}`;
  }
  const detail = message || '操作失败。';
  return suggestions[code] ? `${detail} ${suggestions[code]}` : detail;
}

function isExpectedReadCancellation(error) {
  return ['ARCHIVE_READ_CANCELLED', 'EPUB_READ_CANCELLED', 'PDF_READ_CANCELLED'].includes(error?.code)
    || error?.name === 'AbortException';
}

function scanErrorReason(message) {
  const detail = String(message || '未知原因');
  if (/ENOENT|not found|找不到/i.test(detail)) return '路径不存在或已被移走';
  if (/EACCES|EPERM|permission/i.test(detail)) return '当前账户没有读取权限';
  if (/ENOTDIR/i.test(detail)) return '路径不是目录';
  return detail;
}

function scanErrorMessage(errors, action) {
  const first = errors?.[0];
  if (!first) return `${action}完成。`;
  const target = first.path ? `“${first.path}”` : '某个目录或文件';
  const remaining = errors.length - 1;
  const suffix = remaining > 0 ? `；另有 ${remaining} 项无法访问` : '';
  return `${action}：${target}无法访问（${scanErrorReason(first.message)}）。请检查路径是否存在且有读取权限${suffix}。`;
}

function reportStartupProgress(text, percent) {
  if (!state.startupActive || !window.readerApi?.reportStartupProgress) return;
  window.readerApi.reportStartupProgress({ text, percent }).catch(() => {});
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(date) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function activeCollection() {
  return state.collections.find((item) => item.id === state.activeCollectionId) || null;
}

function booksForCollection(id = state.activeCollectionId) {
  return state.scans.get(id)?.books || [];
}

function findAvailableBook(bookId) {
  for (const scan of state.scans.values()) {
    const book = scan.books.find((item) => item.id === bookId);
    if (book) return book;
  }
  return null;
}

function bookState(bookId) {
  return state.bookStates[bookId] || { unread: true, likeCount: 0, readCount: 0 };
}

function filteredBooks() {
  const query = state.search.toLocaleLowerCase('zh-CN');
  return booksForCollection().filter((book) => {
    const persistent = bookState(book.id);
    if (state.filter === 'unread' && !persistent.unread) return false;
    if (state.filter === 'comic' && !['comic', 'pdf'].includes(book.type)) return false;
    if (state.filter === 'novel' && !['text', 'epub'].includes(book.type)) return false;
    if (query && !`${book.name} ${book.relativePath}`.toLocaleLowerCase('zh-CN').includes(query)) return false;
    return true;
  });
}

function typeLabel(book) {
  if (book.type === 'comic') return book.extension;
  if (book.type === 'text') return 'TXT';
  if (book.type === 'epub') return 'EPUB';
  if (book.type === 'pdf') return 'PDF';
  return book.extension;
}

function renderCollections() {
  elements.collectionList.replaceChildren();
  for (const collection of state.collections) {
    const books = booksForCollection(collection.id);
    const unread = books.filter((book) => bookState(book.id).unread).length;
    const button = document.createElement('button');
    button.className = `collection-item${collection.id === state.activeCollectionId ? ' active' : ''}`;
    button.type = 'button';
    button.dataset.collectionId = collection.id;
    button.disabled = state.selectingCollection || state.recoveryMode || state.collectionSubmitting;

    const icon = document.createElement('span');
    icon.className = 'collection-icon';
    const iconElement = document.createElement('i');
    iconElement.dataset.lucide = 'folder';
    icon.append(iconElement);

    const copy = document.createElement('span');
    copy.className = 'collection-copy';
    const name = document.createElement('strong');
    name.textContent = collection.name;
    const roots = document.createElement('span');
    roots.textContent = collection.files?.length
      ? `${collection.roots.length + collection.files.length} 个路径`
      : `${collection.roots.length} 个目录`;
    copy.append(name, roots);

    const count = document.createElement('span');
    count.className = 'collection-count';
    count.textContent = `${unread}/${books.length}`;
    button.append(icon, copy, count);
    button.addEventListener('click', () => selectCollection(collection.id));
    elements.collectionList.append(button);
  }
  refreshIcons();
}

function renderBooks() {
  const collection = activeCollection();
  const books = filteredBooks();
  elements.bookRows.replaceChildren();

  if (!collection || booksForCollection().length === 0) {
    elements.bookTable.classList.add('hidden');
    elements.emptyState.classList.remove('hidden');
    const heading = elements.emptyState.querySelector('h3');
    heading.textContent = collection ? '当前合集没有可阅读文件' : '添加合集开始阅读';
    return;
  }

  elements.emptyState.classList.add('hidden');
  elements.bookTable.classList.remove('hidden');
  if (books.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-empty';
    empty.textContent = '没有符合条件的书籍';
    elements.bookRows.append(empty);
    return;
  }

  for (const book of books) {
    const persistent = bookState(book.id);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'book-row';
    row.dataset.bookId = book.id;
    row.title = book.relativePath;

    const name = document.createElement('span');
    name.className = 'book-name';
    const strong = document.createElement('strong');
    strong.textContent = book.name;
    name.append(strong);

    const read = document.createElement('span');
    read.className = `read-state${persistent.unread ? ' unread' : ''}`;
    read.textContent = persistent.unread ? '未读' : '已读';

    row.append(name, read);
    row.addEventListener('click', () => openBook(book));
    elements.bookRows.append(row);
  }
}

function renderHistory() {
  elements.historyList.replaceChildren();
  if (state.history.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-empty';
    empty.textContent = '暂无记录';
    elements.historyList.append(empty);
    return;
  }
  state.history.items.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    const number = document.createElement('span');
    number.className = 'history-index';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'history-copy';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.textContent = `${item.collectionName} · ${formatTime(item.openedAt)}`;
    copy.append(name, meta);
    button.append(number, copy);
    const available = findAvailableBook(item.bookId);
    button.disabled = !available;
    if (available) button.addEventListener('click', () => openBook(available));
    elements.historyList.append(button);
  });
}

function applyTheme() {
  const theme = state.settings?.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  elements.themeToggleLabel.textContent = theme === 'dark' ? '亮色模式' : '深色模式';
  setButtonIcon(elements.themeToggle, theme === 'dark' ? 'sun' : 'moon');
  refreshIcons();
}

function randomCandidates() {
  return booksForRandomTab(booksForCollection(), state.filter, state.bookStates);
}

function renderRandomStrategy() {
  elements.strategyBtn.title = '随机策略';
  elements.strategyBtn.setAttribute('aria-expanded', String(!elements.strategyMenu.classList.contains('hidden')));
  elements.strategyMenu.querySelectorAll('[data-strategy]').forEach((button) => {
    const active = button.dataset.strategy === state.randomStrategy;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

function quickGesturesEnabled() {
  return state.settings?.quickGestures !== false;
}

function renderQuickGestures() {
  const enabled = quickGesturesEnabled();
  const label = enabled ? '关闭快捷手势' : '开启快捷手势';
  elements.quickGestureBtn.classList.toggle('toggle-active', enabled);
  elements.quickGestureBtn.title = label;
  elements.quickGestureBtn.setAttribute('aria-label', label);
  elements.quickGestureBtn.setAttribute('aria-pressed', String(enabled));
  elements.quickGestureBtn.disabled = state.collectionSubmitting;
}

function renderHeader() {
  const collection = activeCollection();
  const books = booksForCollection();
  elements.filterTabs.forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
  elements.activeCollectionName.textContent = collection?.name || '尚未选择';
  elements.collectionCount.textContent = `${books.length} 本`;
  const writesLocked = state.scanning || state.recoveryMode || state.collectionSubmitting;
  const enabled = Boolean(collection) && !writesLocked;
  elements.addCollectionBtn.disabled = writesLocked;
  elements.emptyAddBtn.disabled = writesLocked;
  elements.addRootsBtn.disabled = !enabled;
  elements.refreshBtn.disabled = !enabled;
  elements.editCollectionBtn.disabled = !enabled;
  elements.deleteCollectionBtn.disabled = !enabled;
  elements.resetPoolBtn.disabled = !enabled || books.length === 0;
  elements.favoritesBtn.disabled = !collection || state.collectionSubmitting;
  elements.importBtn.disabled = state.scanning || state.collectionSubmitting;
  elements.initializeBtn.disabled = state.scanning || state.collectionSubmitting;
  elements.exportBtn.disabled = state.recoveryMode || state.collectionSubmitting;
  elements.themeToggle.disabled = state.recoveryMode || state.themeChanging || state.collectionSubmitting;
  elements.sidebarToggle.disabled = state.recoveryMode || state.sidebarChanging || state.collectionSubmitting;
  const canDraw = enabled && randomCandidates().length > 0;
  elements.drawBtn.disabled = !canDraw;
  elements.readerRandomBtn.disabled = !canDraw || state.openingBook;
  elements.drawBtn.querySelector('span').textContent = '随机抽取';
  const sidebarLabel = state.settings.sidebarCollapsed ? '显示合集栏' : '隐藏合集栏';
  elements.sidebarToggle.title = sidebarLabel;
  elements.sidebarToggle.setAttribute('aria-label', sidebarLabel);
  setButtonIcon(elements.sidebarToggle, state.settings.sidebarCollapsed ? 'panel-left-open' : 'panel-left-close');
  refreshIcons();
  syncCollectionDialogControls();
}

function renderAll() {
  renderCollections();
  renderHeader();
  renderBooks();
  renderHistory();
  applyTheme();
  renderRandomStrategy();
  renderQuickGestures();
  elements.app.classList.toggle('sidebar-collapsed', state.settings.sidebarCollapsed);
}

async function refreshPersistentState() {
  const latest = await window.readerApi.getState();
  state.collections = latest.collections;
  state.bookStates = latest.bookStates;
  state.settings = latest.settings;
  state.recoveryMode = latest.recoveryMode === true;
  state.pendingRenameRecovery = latest.pendingRenameRecovery || null;
  state.activeCollectionId = latest.settings.activeCollectionId || state.collections[0]?.id || null;
  state.filter = state.filterByCollection.get(state.activeCollectionId) || 'all';
}

function renderRenameRecoveryDialog() {
  const recovery = state.pendingRenameRecovery;
  if (!recovery) return;
  const invalid = recovery.reason === 'INVALID_RECOVERY_RECORD';
  elements.renameRecoveryTitle.textContent = invalid ? '重命名恢复记录已损坏' : '检测到重命名冲突';
  elements.renameRecoveryMessage.textContent = invalid
    ? '恢复记录无法读取。清除该无效记录后将重新扫描书库；不会删除任何书籍文件。'
    : '旧路径和新路径同时存在。请选择要关联阅读状态的路径；程序不会删除任一文件。';
  elements.renameRecoveryPaths.classList.toggle('hidden', invalid);
  elements.renameRecoveryOldPath.textContent = recovery.oldPath || '旧路径不可用';
  elements.renameRecoveryNewPath.textContent = recovery.newPath || '新路径不可用';
  const disabled = state.recoveryResolving;
  [elements.renameRecoveryOldBtn, elements.renameRecoveryNewBtn, elements.renameRecoveryBothBtn]
    .forEach((button) => {
      button.classList.toggle('hidden', invalid);
      button.disabled = disabled;
    });
  elements.renameRecoveryDiscardBtn.classList.toggle('hidden', !invalid);
  elements.renameRecoveryDiscardBtn.disabled = disabled;
}

function openRenameRecoveryDialog() {
  const recovery = state.pendingRenameRecovery;
  const actionable = recovery?.reason === 'INVALID_RECOVERY_RECORD' || recovery?.oldPath && recovery?.newPath;
  if (!actionable || elements.renameRecoveryDialog.open) return;
  renderRenameRecoveryDialog();
  elements.renameRecoveryDialog.showModal();
}

async function resolveRenameRecovery(decision) {
  if (state.recoveryResolving || !state.pendingRenameRecovery) return;
  state.recoveryResolving = true;
  renderRenameRecoveryDialog();
  try {
    await window.readerApi.resolveRenameRecovery(decision);
    elements.renameRecoveryDialog.close();
    state.recoveryResolving = false;
    await refreshPersistentState();
    await scanAll();
    showToast('重命名恢复已完成，书库已重新扫描。');
  } catch (error) {
    state.recoveryResolving = false;
    renderRenameRecoveryDialog();
    showToast(errorMessage(error), 'error', 5200);
  }
}

async function selectCollection(id) {
  if (state.selectingCollection || state.recoveryMode || state.collectionSubmitting || id === state.activeCollectionId) return;
  const previousId = state.activeCollectionId;
  const previousFilter = state.filter;
  if (state.activeCollectionId) state.filterByCollection.set(state.activeCollectionId, state.filter);
  state.activeCollectionId = id;
  state.filter = state.filterByCollection.get(id) || 'all';
  state.selectingCollection = true;
  renderAll();
  try {
    state.settings = await window.readerApi.updateSettings({ activeCollectionId: id });
  } catch (error) {
    state.activeCollectionId = previousId;
    state.filter = previousFilter;
    showToast(errorMessage(error), 'error');
  } finally {
    state.selectingCollection = false;
    renderAll();
  }
}

async function scanAll() {
  if (state.collectionSubmitting) return;
  if (state.collections.length === 0) {
    elements.scanStatus.textContent = '等待添加合集';
    renderAll();
    return;
  }
  state.scanning = true;
  elements.scanStatus.textContent = '正在扫描全部合集';
  renderHeader();
  try {
    const results = await window.readerApi.scanAll();
    state.scans = new Map(results.map((result) => [result.collectionId, result]));
    await refreshPersistentState();
    const scanErrors = results.flatMap((result) => result.errors || []);
    const errorCount = scanErrors.length;
    elements.scanStatus.textContent = errorCount ? `扫描完成，${errorCount} 项不可访问` : '书库已就绪';
    if (errorCount) showToast(scanErrorMessage(scanErrors, '扫描完成'), 'warning', 5200);
  } catch (error) {
    elements.scanStatus.textContent = '扫描失败';
    showToast(errorMessage(error), 'error', 5200);
  } finally {
    state.scanning = false;
    renderAll();
  }
}

async function refreshActiveCollection() {
  const collection = activeCollection();
  if (!collection || state.scanning || state.recoveryMode || state.collectionSubmitting) return;
  state.scanning = true;
  elements.scanStatus.textContent = `正在刷新 ${collection.name}`;
  renderHeader();
  try {
    const result = await window.readerApi.scanCollection(collection.id);
    state.scans.set(collection.id, result);
    await refreshPersistentState();
    elements.scanStatus.textContent = result.errors.length ? `刷新完成，${result.errors.length} 项不可访问` : '书库已就绪';
    showToast(result.errors.length
      ? scanErrorMessage(result.errors, '刷新完成')
      : `刷新完成，共 ${result.books.length} 本。`, result.errors.length ? 'warning' : 'info');
  } catch (error) {
    elements.scanStatus.textContent = '刷新失败';
    showToast(errorMessage(error), 'error');
  } finally {
    state.scanning = false;
    renderAll();
  }
}

const reader = new ReaderController({
  onError: (error) => {
    if (isExpectedReadCancellation(error)) return;
    showToast(errorMessage(error), 'error', 5200);
  },
  getQuickGesturesEnabled: quickGesturesEnabled,
  onToggleFullscreen: () => toggleFullscreen(),
  onCloseRequested: () => closeReader(),
  onArchiveSaved: () => showToast('存档已保存。'),
  onArchiveLoaded: () => showToast('已恢复存档位置。'),
  onModeChange: async (type, mode) => {
    state.settings = await window.readerApi.updateSettings({ readerMode: { [type]: mode } });
  },
  onFitChange: async (type, fit, zoom) => {
    if (type === 'comic') return;
    state.settings = await window.readerApi.updateSettings({
      fitMode: { [type]: fit },
      zoomScale: { [type]: zoom }
    });
  },
  onZoomChange: async (type, zoom) => {
    if (type === 'comic') return;
    state.settings = await window.readerApi.updateSettings({ zoomScale: { [type]: zoom } });
  },
  onEncodingChange: async (bookId, encoding) => {
    const next = { ...state.settings.textEncodings };
    if (encoding) next[bookId] = encoding;
    else delete next[bookId];
    state.settings = await window.readerApi.updateSettings({ textEncodings: next });
  },
  onNovelSettingsChange: async (patch) => {
    state.settings = await window.readerApi.updateSettings({ novel: patch });
  }
});

async function openBook(book, { replaceCurrent = false, recordOpen = true, position = null, preserveLiked = false } = {}) {
  if (!book || state.openingBook || (state.currentBook && !replaceCurrent)) return false;
  const previousBook = state.currentBook;
  state.openingBook = true;
  elements.readerRandomBtn.disabled = true;
  if (replaceCurrent && previousBook?.temporary && previousBook.id !== book.id) {
    await window.readerApi.releaseTemporary(previousBook.id).catch(() => {});
  }
  state.currentBook = book;
  state.temporaryState = book.temporary
    ? (previousBook?.id === book.id && state.temporaryState) || { unread: true, likeCount: 0, readCount: 0 }
    : null;
  state.likedThisOpen = preserveLiked || Boolean(book.temporary && state.temporaryState?.likeCount);
  elements.readerTitle.textContent = book.name;
  elements.readerMeta.textContent = `${typeLabel(book)} · ${formatSize(book.size)}`;
  elements.readerLikeCount.textContent = String(book.temporary ? state.temporaryState.likeCount : bookState(book.id).likeCount);
  elements.likeBtn.classList.toggle('liked', preserveLiked);
  try {
    await reader.open(book, state.settings);
    applyFullscreenState(state.fullscreen);
    if (position) await reader.restorePosition(position);
    if (recordOpen) {
      const persistent = await window.readerApi.markOpened(book.id);
      state.bookStates[book.id] = persistent;
      state.history.add(book, activeCollection()?.name || '合集');
    }
    renderAll();
    return true;
  } catch (error) {
    if (state.currentBook === book) {
      await reader.close().catch(() => {});
      state.currentBook = null;
      if (book.temporary) await window.readerApi.releaseTemporary(book.id).catch(() => {});
      state.temporaryState = null;
    }
    const expectedCancellation = ['ARCHIVE_READ_CANCELLED', 'EPUB_READ_CANCELLED', 'PDF_READ_CANCELLED'].includes(error?.code)
      && (state.readerClosing || state.currentBook !== book || error?.details?.expected === true);
    if (!expectedCancellation) {
      showToast(errorMessage(error), error.code === 'ENCRYPTED_CONTENT' ? 'warning' : 'error', 5400);
    }
    return false;
  } finally {
    state.openingBook = false;
    renderHeader();
  }
}

async function closeReader() {
  const focusBookId = state.pendingRandomBookId;
  state.pendingRandomBookId = null;
  const closingBook = state.currentBook;
  state.readerClosing = true;
  try {
    await window.readerApi.setFullscreen(false).catch(() => {});
    applyFullscreenState(false);
    await reader.close();
    if (closingBook?.temporary) await window.readerApi.releaseTemporary(closingBook.id).catch(() => {});
    state.currentBook = null;
    state.likedThisOpen = false;
    state.temporaryState = null;
    if (focusBookId) focusBookInLibrary(focusBookId);
  } finally {
    state.readerClosing = false;
  }
}

async function drawRandom({ fromReader = false } = {}) {
  const { book } = selectRandomBook({
    books: booksForCollection(),
    filter: state.filter,
    bookStates: state.bookStates,
    strategy: state.randomStrategy,
    successfulDraws: state.successfulDraws
  });
  if (!book) {
    showToast('当前页签没有可抽取文件。');
    return;
  }
  state.pendingRandomBookId = book.id;
  const opened = await openBook(book, { replaceCurrent: fromReader });
  if (opened) {
    state.successfulDraws += 1;
  } else {
    state.pendingRandomBookId = null;
  }
}

async function likeCurrent() {
  if (!state.currentBook || state.likedThisOpen) {
    if (state.likedThisOpen) showToast('本次打开已经点过赞。');
    return;
  }
  try {
    if (state.currentBook.temporary) {
      state.temporaryState = await window.readerApi.addLike(state.currentBook.id);
      state.likedThisOpen = true;
      elements.readerLikeCount.textContent = String(state.temporaryState.likeCount);
      elements.likeBtn.classList.add('liked');
      return;
    }
    const persistent = await window.readerApi.addLike(state.currentBook.id);
    state.bookStates[state.currentBook.id] = persistent;
    state.likedThisOpen = true;
    elements.readerLikeCount.textContent = String(persistent.likeCount);
    elements.likeBtn.classList.add('liked');
    renderBooks();
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function renderSelectedRoots() {
  elements.selectedRoots.replaceChildren();
  if (state.selectedRoots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'root-empty';
    empty.textContent = '尚未选择目录';
    elements.selectedRoots.append(empty);
    return;
  }
  state.selectedRoots.forEach((root, index) => {
    const item = document.createElement('div');
    item.className = 'root-item';
    const label = document.createElement('span');
    label.textContent = root;
    label.title = root;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn small';
    remove.disabled = state.collectionSubmitting;
    remove.title = '移除目录';
    remove.setAttribute('aria-label', '移除目录');
    const icon = document.createElement('i');
    icon.dataset.lucide = 'x';
    remove.append(icon);
    remove.addEventListener('click', () => {
      state.selectedRoots.splice(index, 1);
      renderSelectedRoots();
    });
    item.append(label, remove);
    elements.selectedRoots.append(item);
  });
  refreshIcons();
}

function syncCollectionDialogControls() {
  const disabled = state.collectionSubmitting;
  [
    elements.closeCollectionDialog,
    elements.cancelCollectionBtn,
    elements.saveCollectionBtn,
    elements.chooseFilesBtn,
    elements.chooseRootsBtn
  ].forEach((element) => {
    if (element) element.disabled = disabled;
  });
  if (elements.collectionNameInput) elements.collectionNameInput.disabled = disabled;
}

function isCurrentCollectionSubmission(submission) {
  return state.collectionSubmitting
    && state.collectionSubmitRunId === submission.runId
    && state.collectionDialogSessionId === submission.dialogSessionId;
}

function openCollectionDialog(collection = null, initialRoots = []) {
  if (state.scanning || state.recoveryMode || state.collectionSubmitting) return;
  state.collectionDialogSessionId += 1;
  state.editingCollectionId = collection?.id || null;
  state.selectedRoots = collection ? [...collection.roots, ...(collection.files || [])] : [...initialRoots];
  elements.collectionDialogTitle.textContent = collection ? '编辑合集' : '新建合集';
  elements.collectionNameInput.value = collection?.name || '';
  renderSelectedRoots();
  if (!elements.collectionDialog.open) elements.collectionDialog.showModal();
  elements.collectionNameInput.focus();
}

function closeCollectionDialog({ force = false, sessionId = state.collectionDialogSessionId } = {}) {
  if (state.collectionSubmitting && !force) return false;
  if (sessionId !== state.collectionDialogSessionId) return false;
  elements.collectionDialog.close();
  state.selectedRoots = [];
  state.editingCollectionId = null;
  syncCollectionDialogControls();
  return true;
}

async function saveCollection() {
  if (state.scanning || state.recoveryMode || state.collectionSubmitting) return;
  const name = elements.collectionNameInput.value.trim();
  if (!name) {
    showToast('请输入合集名称。', 'warning');
    return;
  }
  if (state.selectedRoots.length === 0) {
    showToast('请至少选择一个文件或目录。', 'warning');
    return;
  }
  const submission = Object.freeze({
    runId: state.collectionSubmitRunId + 1,
    dialogSessionId: state.collectionDialogSessionId,
    editingId: state.editingCollectionId,
    operation: state.editingCollectionId ? 'update' : 'add',
    name,
    paths: Object.freeze([...state.selectedRoots])
  });
  state.collectionSubmitRunId = submission.runId;
  state.collectionSubmitting = true;
  syncCollectionDialogControls();
  renderSelectedRoots();
  renderHeader();
  const wasEditing = submission.operation === 'update';
  let collectionSaved = false;
  try {
    const selection = await window.readerApi.validateSelection(submission.paths);
    if (!isCurrentCollectionSubmission(submission)) return;
    const input = {
      name: submission.name,
      roots: [...selection.roots],
      files: [...selection.files]
    };
    let collection;
    if (submission.operation === 'update') {
      collection = await window.readerApi.updateCollection({ id: submission.editingId, ...input });
    } else {
      collection = await window.readerApi.addCollection(input);
    }
    if (!isCurrentCollectionSubmission(submission)) return;
    collectionSaved = true;
    state.scanning = true;
    elements.scanStatus.textContent = `正在扫描 ${collection.name}`;
    renderHeader();
    closeCollectionDialog({ force: true, sessionId: submission.dialogSessionId });
    await refreshPersistentState();
    state.activeCollectionId = collection.id;
    state.filter = state.filterByCollection.get(collection.id) || 'all';
    const result = await window.readerApi.scanCollection(collection.id);
    state.scans.set(collection.id, result);
    elements.scanStatus.textContent = result.errors.length ? `扫描完成，${result.errors.length} 项不可访问` : '书库已就绪';
    renderAll();
    showToast(
      result.errors.length
        ? scanErrorMessage(result.errors, wasEditing ? '合集已更新，扫描完成' : '合集已创建，扫描完成')
        : wasEditing ? '合集已更新。' : '合集已创建。',
      result.errors.length ? 'warning' : 'info',
      result.errors.length ? 5200 : 3600
    );
  } catch (error) {
    if (!isCurrentCollectionSubmission(submission)) return;
    if (collectionSaved) {
      elements.scanStatus.textContent = '扫描失败';
      showToast(`合集已保存，但扫描失败。 ${errorMessage(error)}`, 'error', 5200);
    } else {
      showToast(errorMessage(error), 'error', 5200);
    }
  } finally {
    if (isCurrentCollectionSubmission(submission)) {
      if (collectionSaved) state.scanning = false;
      state.collectionSubmitting = false;
      syncCollectionDialogControls();
      renderAll();
    }
  }
}

function askConfirmation(title, message, acceptLabel = '确认') {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmAccept.textContent = acceptLabel;
  elements.confirmDialog.returnValue = '';
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener('close', () => resolve(elements.confirmDialog.returnValue === 'accept'), { once: true });
  });
}

async function removeActiveCollection() {
  const collection = activeCollection();
  if (!collection || state.scanning || state.recoveryMode || state.collectionSubmitting) return;
  const accepted = await askConfirmation('删除合集', `只删除合集“${collection.name}”的配置，不会删除任何原始书籍文件。`, '删除合集');
  if (!accepted) return;
  try {
    await window.readerApi.removeCollection(collection.id);
    state.scans.delete(collection.id);
    state.filterByCollection.delete(collection.id);
    await refreshPersistentState();
    renderAll();
    showToast('合集配置已删除。');
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function resetUnread() {
  const collection = activeCollection();
  if (!collection || state.scanning || state.recoveryMode || state.collectionSubmitting) return;
  const accepted = await askConfirmation('重置', `将“${collection.name}”中全部书籍恢复为未读状态。`, '重置');
  if (!accepted) return;
  try {
    state.bookStates = await window.readerApi.resetUnread(collection.id);
    renderAll();
    showToast('未读卡池已重置。');
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function restoreBackup() {
  if (state.scanning || state.collectionSubmitting) return;
  const accepted = await askConfirmation('恢复数据', '恢复会覆盖当前合集、未读状态、点赞、阅读次数和界面设置，不会修改原始书籍文件。', '选择备份');
  if (!accepted) return;
  try {
    const result = await window.readerApi.importBackup();
    if (result.canceled) return;
    state.history.clear();
    state.filterByCollection.clear();
    state.scans.clear();
    await refreshPersistentState();
    await scanAll();
    showToast('数据已恢复。');
  } catch (error) {
    showToast(errorMessage(error), 'error', 5200);
  }
}

function focusBookInLibrary(bookId) {
  state.search = '';
  elements.searchInput.value = '';
  renderAll();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const row = elements.bookRows.querySelector(`[data-book-id="${bookId}"]`);
    if (!row) return;
    const target = row.offsetTop - (elements.bookRows.clientHeight - row.offsetHeight) / 2;
    elements.bookRows.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
    row.classList.add('random-focus');
    setTimeout(() => row.classList.remove('random-focus'), 1800);
  }));
}

function applyFullscreenState(value) {
  state.fullscreen = value === true;
  elements.readerOverlay.classList.toggle('is-fullscreen', state.fullscreen);
  elements.fullscreenBtn.title = state.fullscreen ? '退出全屏' : '全屏';
  elements.fullscreenBtn.setAttribute('aria-label', elements.fullscreenBtn.title);
  setButtonIcon(elements.fullscreenBtn, state.fullscreen ? 'minimize-2' : 'maximize-2');
  if (state.fullscreen && state.currentBook) revealToolbar();
  else {
    clearTimeout(toolbarHideTimer);
    elements.readerOverlay.classList.remove('toolbar-visible');
  }
  refreshIcons();
}

async function toggleFullscreen() {
  try {
    applyFullscreenState(await window.readerApi.toggleFullscreen());
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function revealToolbar() {
  if (!state.fullscreen || !state.currentBook) return;
  clearTimeout(toolbarHideTimer);
  elements.readerOverlay.classList.add('toolbar-visible');
  toolbarHideTimer = setTimeout(() => elements.readerOverlay.classList.remove('toolbar-visible'), 1500);
}

function revealPageControls() {
  if (!reader.isPageMode()) return;
  clearTimeout(pageControlsHideTimer);
  elements.readerOverlay.classList.add('page-controls-visible');
  pageControlsHideTimer = setTimeout(() => elements.readerOverlay.classList.remove('page-controls-visible'), 1500);
}

function applyRenameResult(result) {
  for (const update of result.updates) {
    const scan = state.scans.get(update.collectionId);
    if (!scan) continue;
    scan.books = scan.books.map((book) => book.id === result.oldId ? update.book : book);
  }
  delete state.bookStates[result.oldId];
  state.bookStates[result.newId] = result.bookState;
  state.settings = result.settings;
  state.history.renameBook(result.oldId, result.updates[0]?.book || { id: result.newId, name: elements.renameInput.value });
  if (state.pendingRandomBookId === result.oldId) state.pendingRandomBookId = result.newId;
  return result.updates.find((item) => item.collectionId === state.activeCollectionId)?.book || result.updates[0]?.book || null;
}

function openRenameDialog() {
  const book = state.currentBook;
  if (!book) return;
  const suffix = `.${book.extension}`;
  elements.renameInput.value = book.name.toLocaleLowerCase('en-US').endsWith(suffix.toLocaleLowerCase('en-US'))
    ? book.name.slice(0, -suffix.length)
    : book.name;
  elements.renameExtension.textContent = suffix;
  if (!elements.renameDialog.open) elements.renameDialog.showModal();
  elements.renameInput.focus();
  elements.renameInput.select();
}

function closeRenameDialog() {
  if (elements.renameDialog.open) elements.renameDialog.close();
}

async function renameCurrentBook() {
  const book = state.currentBook;
  if (!book) return;
  const baseName = elements.renameInput.value.trim();
  const currentBaseName = book.name.slice(0, -(book.extension.length + 1));
  if (!baseName) {
    showToast('请输入新的主文件名。', 'warning');
    return;
  }
  if (baseName === currentBaseName) {
    closeRenameDialog();
    return;
  }

  const position = reader.capturePosition();
  const preserveLiked = state.likedThisOpen;
  elements.saveRenameBtn.disabled = true;
  closeRenameDialog();
  await reader.close();
  state.currentBook = null;
  let result;
  try {
    result = await window.readerApi.renameBook(book.id, baseName);
  } catch (error) {
    showToast(errorMessage(error), 'error', 5200);
    await openBook(book, { recordOpen: false, position, preserveLiked }).catch(() => false);
    elements.saveRenameBtn.disabled = false;
    return;
  }
  try {
    const renamedBook = applyRenameResult(result);
    if (!renamedBook) throw new Error('重命名后无法更新当前书库。');
    const reopened = await openBook(renamedBook, { recordOpen: false, position, preserveLiked });
    if (reopened) showToast('文件已重命名，并恢复到原阅读位置。');
    else showToast('文件已重命名，但无法重新打开。', 'warning', 5200);
  } catch (error) {
    showToast(errorMessage(error), 'error', 5200);
  } finally {
    elements.saveRenameBtn.disabled = false;
  }
}

async function trashCurrentBook() {
  const book = state.currentBook;
  if (!book) return;
  const accepted = await askConfirmation(
    '删除当前文件',
    `将“${book.name}”移入 Windows 回收站，并清理对应的未读、点赞、次数、编码和存档记录。`,
    '移入回收站'
  );
  if (!accepted) return;

  const position = reader.capturePosition();
  const preserveLiked = state.likedThisOpen;
  await window.readerApi.setFullscreen(false).catch(() => {});
  applyFullscreenState(false);
  await reader.close();
  state.currentBook = null;
  try {
    const result = await window.readerApi.trashBook(book.id);
    for (const collectionId of result.collectionIds) {
      const scan = state.scans.get(collectionId);
      if (scan) scan.books = scan.books.filter((item) => item.id !== book.id);
    }
    delete state.bookStates[book.id];
    state.pendingRandomBookId = null;
    state.likedThisOpen = false;
    renderAll();
    showToast('文件已移入回收站。');
  } catch (error) {
    showToast(errorMessage(error), 'error', 5200);
    if (error?.details?.fileTrashed) {
      for (const scan of state.scans.values()) {
        scan.books = scan.books.filter((item) => item.id !== book.id);
      }
      state.pendingRandomBookId = null;
      state.likedThisOpen = false;
      renderAll();
    } else {
      await openBook(book, { recordOpen: false, position, preserveLiked }).catch(() => false);
    }
  }
}

async function showCurrentBookInFolder() {
  if (!state.currentBook) return;
  try {
    await window.readerApi.showBookInFolder(state.currentBook.id);
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function addRootsToActiveCollection() {
  const collection = activeCollection();
  if (!collection || state.scanning || state.recoveryMode || state.collectionSubmitting) return;
  try {
    const roots = await window.readerApi.selectRoots();
    if (roots.length === 0) return;
    const selection = await window.readerApi.validateSelection(roots);
    const merged = new Map(collection.roots.map((root) => [root.toLocaleLowerCase('en-US'), root]));
    selection.roots.forEach((root) => merged.set(root.toLocaleLowerCase('en-US'), root));
    const fileMap = new Map((collection.files || []).map((file) => [file.toLocaleLowerCase('en-US'), file]));
    selection.files.forEach((file) => fileMap.set(file.toLocaleLowerCase('en-US'), file));
    if (merged.size === collection.roots.length && fileMap.size === (collection.files || []).length) {
      showToast('所选路径已在当前合集内。');
      return;
    }
    await window.readerApi.updateCollection({ id: collection.id, name: collection.name, roots: [...merged.values()], files: [...fileMap.values()] });
    await refreshPersistentState();
    await refreshActiveCollection();
    showToast('目录已增补并完成刷新。');
  } catch (error) {
    showToast(errorMessage(error), 'error', 5200);
  }
}

function renderFavoriteList(host, items) {
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-empty';
    empty.textContent = '暂无喜爱记录';
    host.append(empty);
    return;
  }
  items.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `favorite-item${item.available ? '' : ' unavailable'}`;
    row.disabled = !item.available;
    row.title = item.path;
    const rank = document.createElement('span');
    rank.className = 'favorite-rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('strong');
    name.textContent = item.name;
    const status = document.createElement('span');
    status.className = 'favorite-status';
    status.textContent = item.available ? `喜爱 ${item.likeCount} 次` : `喜爱 ${item.likeCount} 次 · 文件不存在`;
    row.append(rank, name, status);
    if (item.available) {
      row.addEventListener('click', () => {
        const book = booksForCollection().find((candidate) => candidate.id === item.id);
        if (!book) return;
        elements.favoritesDialog.close();
        openBook(book);
      });
    }
    host.append(row);
  });
}

async function openFavorites() {
  const collection = activeCollection();
  if (!collection || state.collectionSubmitting) return;
  try {
    const favorites = await window.readerApi.getFavorites(collection.id);
    renderFavoriteList(elements.favoriteComicList, favorites.comic);
    renderFavoriteList(elements.favoriteNovelList, favorites.novel);
    elements.favoritesDialog.showModal();
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function initializeData() {
  if (state.scanning || state.collectionSubmitting) return;
  const first = await askConfirmation(
    '初始化全部数据',
    '将清除合集、未读、点赞、次数、界面设置、安全备份、缓存和本次历史。原始书籍与外部备份不会删除。',
    '继续确认'
  );
  if (!first) return;
  const second = await askConfirmation('再次确认初始化', '此操作会立即清空当前应用数据，之后只能通过外部备份恢复。', '确认初始化');
  if (!second) return;
  try {
    state.pendingRandomBookId = null;
    if (state.currentBook) await closeReader();
    const fresh = await window.readerApi.initializeData();
    state.collections = fresh.collections;
    state.bookStates = fresh.bookStates;
    state.settings = fresh.settings;
    state.recoveryMode = false;
    state.pendingRenameRecovery = null;
    state.activeCollectionId = null;
    state.filter = 'all';
    state.scans.clear();
    state.history.clear();
    state.filterByCollection.clear();
    state.search = '';
    state.randomStrategy = RANDOM_STRATEGIES.DEFAULT;
    state.successfulDraws = 0;
    elements.searchInput.value = '';
    elements.filterTabs.forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all'));
    elements.scanStatus.textContent = '等待添加合集';
    renderAll();
    showToast('应用数据已初始化。');
  } catch (error) {
    showToast(errorMessage(error), 'error', 5200);
  }
}

function isFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

async function handlePathSelection(paths) {
  try {
    if (paths.length === 0) return;
    if (state.collectionSubmitting) return;
    if (state.recoveryMode) {
      showToast('配置处于保护模式，请先恢复备份或初始化数据。', 'warning', 5200);
      return;
    }
    const selection = await window.readerApi.validateSelection(paths);
    if (selection.files.length === 1 && selection.roots.length === 0) {
      const temporaryBook = await window.readerApi.openTemporary(selection.files[0]);
      await openBook(temporaryBook, { recordOpen: false });
      return;
    }
    if (state.scanning) {
      showToast('正在扫描书库，请等待扫描完成后再创建合集。', 'warning');
      return;
    }
    openCollectionDialog(null, [...selection.roots, ...selection.files]);
  } catch (error) {
    showToast(errorMessage(error), 'warning', 5200);
  }
}

async function acceptDroppedPaths(event) {
  const files = [...(event.dataTransfer?.files || [])];
  const paths = files.map((file) => window.readerApi.getPathForFile(file)).filter(Boolean);
  await handlePathSelection(paths);
}

function bindEvents() {
  elements.addCollectionBtn.addEventListener('click', () => openCollectionDialog());
  elements.emptyAddBtn.addEventListener('click', () => openCollectionDialog());
  elements.editCollectionBtn.addEventListener('click', () => openCollectionDialog(activeCollection()));
  elements.closeCollectionDialog.addEventListener('click', closeCollectionDialog);
  elements.cancelCollectionBtn.addEventListener('click', closeCollectionDialog);
  elements.collectionDialog.addEventListener('cancel', (event) => {
    if (state.collectionSubmitting) event.preventDefault();
  });
  elements.collectionDialog.addEventListener('click', (event) => {
    if (state.collectionSubmitting && event.target === elements.collectionDialog) event.preventDefault();
  });
  elements.collectionDialog.addEventListener('close', () => {
    if (state.collectionSubmitting) return;
    state.selectedRoots = [];
    state.editingCollectionId = null;
    syncCollectionDialogControls();
  });
  elements.chooseFilesBtn.addEventListener('click', async () => {
    try {
      const files = await window.readerApi.selectPaths();
      if (!state.editingCollectionId && state.selectedRoots.length === 0 && files.length === 1) {
        closeCollectionDialog();
        await handlePathSelection(files);
        return;
      }
      const merged = new Map(state.selectedRoots.map((root) => [root.toLocaleLowerCase('en-US'), root]));
      files.forEach((file) => merged.set(file.toLocaleLowerCase('en-US'), file));
      state.selectedRoots = [...merged.values()];
      renderSelectedRoots();
    } catch (error) {
      showToast(errorMessage(error), 'error');
    }
  });
  elements.chooseRootsBtn.addEventListener('click', async () => {
    try {
      const roots = await window.readerApi.selectRoots();
      const merged = new Map(state.selectedRoots.map((selected) => [selected.toLocaleLowerCase('en-US'), selected]));
      roots.forEach((root) => merged.set(root.toLocaleLowerCase('en-US'), root));
      state.selectedRoots = [...merged.values()];
      renderSelectedRoots();
    } catch (error) {
      showToast(errorMessage(error), 'error');
    }
  });
  elements.collectionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveCollection();
  });
  elements.renameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    renameCurrentBook();
  });
  elements.closeRenameDialog.addEventListener('click', closeRenameDialog);
  elements.cancelRenameBtn.addEventListener('click', closeRenameDialog);
  elements.drawBtn.addEventListener('click', () => drawRandom());
  elements.addRootsBtn.addEventListener('click', addRootsToActiveCollection);
  elements.refreshBtn.addEventListener('click', refreshActiveCollection);
  elements.deleteCollectionBtn.addEventListener('click', removeActiveCollection);
  elements.resetPoolBtn.addEventListener('click', resetUnread);
  elements.searchInput.addEventListener('input', () => {
    state.search = elements.searchInput.value;
    renderBooks();
  });
  elements.filterTabs.forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    if (state.activeCollectionId) state.filterByCollection.set(state.activeCollectionId, state.filter);
    elements.filterTabs.forEach((item) => item.classList.toggle('active', item === button));
    renderHeader();
    renderBooks();
  }));
  elements.strategyBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    elements.strategyMenu.classList.toggle('hidden');
    renderRandomStrategy();
  });
  elements.strategyMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-strategy]');
    if (!button) return;
    state.randomStrategy = button.dataset.strategy;
    elements.strategyMenu.classList.add('hidden');
    renderRandomStrategy();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.strategy-control')) {
      elements.strategyMenu.classList.add('hidden');
      renderRandomStrategy();
    }
  });
  elements.sidebarToggle.addEventListener('click', async () => {
    if (state.sidebarChanging || state.recoveryMode || state.collectionSubmitting) return;
    const previous = state.settings.sidebarCollapsed;
    const collapsed = !previous;
    state.sidebarChanging = true;
    state.settings.sidebarCollapsed = collapsed;
    renderAll();
    try {
      state.settings = await window.readerApi.updateSettings({ sidebarCollapsed: collapsed });
    } catch (error) {
      state.settings.sidebarCollapsed = previous;
      showToast(errorMessage(error), 'error');
    } finally {
      state.sidebarChanging = false;
      renderAll();
    }
  });
  elements.exportBtn.addEventListener('click', async () => {
    if (state.collectionSubmitting) return;
    try {
      const result = await window.readerApi.exportBackup();
      if (!result.canceled) showToast('数据备份已完成。');
    } catch (error) {
      showToast(errorMessage(error), 'error');
    }
  });
  elements.importBtn.addEventListener('click', restoreBackup);
  elements.favoritesBtn.addEventListener('click', openFavorites);
  elements.closeFavoritesDialog.addEventListener('click', () => elements.favoritesDialog.close());
  elements.initializeBtn.addEventListener('click', initializeData);
  elements.renameRecoveryOldBtn.addEventListener('click', () => resolveRenameRecovery('old'));
  elements.renameRecoveryNewBtn.addEventListener('click', () => resolveRenameRecovery('new'));
  elements.renameRecoveryBothBtn.addEventListener('click', () => resolveRenameRecovery('both'));
  elements.renameRecoveryDiscardBtn.addEventListener('click', () => resolveRenameRecovery('discard-invalid'));
  elements.renameRecoveryDialog.addEventListener('cancel', (event) => event.preventDefault());
  elements.renameRecoveryDialog.addEventListener('click', (event) => {
    if (event.target === elements.renameRecoveryDialog) event.preventDefault();
  });
  elements.dataFolderBtn.addEventListener('click', () => window.readerApi.showDataFolder().catch((error) => showToast(errorMessage(error), 'error')));
  elements.themeToggle.addEventListener('click', async () => {
    if (state.themeChanging || state.recoveryMode || state.collectionSubmitting) return;
    const previous = state.settings.theme;
    const theme = previous === 'light' ? 'dark' : 'light';
    state.themeChanging = true;
    state.settings.theme = theme;
    renderAll();
    try {
      state.settings = await window.readerApi.updateSettings({ theme });
    } catch (error) {
      state.settings.theme = previous;
      showToast(errorMessage(error), 'error');
    } finally {
      state.themeChanging = false;
      renderAll();
    }
  });
  elements.closeReaderBtn.addEventListener('click', closeReader);
  elements.likeBtn.addEventListener('click', likeCurrent);
  elements.readerRandomBtn.addEventListener('click', () => drawRandom({ fromReader: true }));
  elements.showBookFolderBtn.addEventListener('click', showCurrentBookInFolder);
  elements.renameBookBtn.addEventListener('click', openRenameDialog);
  elements.trashBookBtn.addEventListener('click', trashCurrentBook);
  elements.quickGestureBtn.addEventListener('click', async () => {
    if (state.collectionSubmitting) return;
    const previous = quickGesturesEnabled();
    state.settings.quickGestures = !previous;
    renderQuickGestures();
    elements.quickGestureBtn.disabled = true;
    try {
      state.settings = await window.readerApi.updateSettings({ quickGestures: !previous });
    } catch (error) {
      state.settings.quickGestures = previous;
      renderQuickGestures();
      showToast(errorMessage(error), 'error');
    } finally {
      elements.quickGestureBtn.disabled = false;
    }
  });
  elements.fullscreenBtn.addEventListener('click', toggleFullscreen);
  elements.readerOverlay.addEventListener('pointermove', (event) => {
    if (state.fullscreen && event.clientY <= 76) revealToolbar();
    if (reader.isPageMode() && event.clientY >= window.innerHeight - 76) revealPageControls();
  });
  elements.readerToolbar.addEventListener('pointerenter', () => {
    if (state.fullscreen) {
      clearTimeout(toolbarHideTimer);
      elements.readerOverlay.classList.add('toolbar-visible');
    }
  });
  elements.readerToolbar.addEventListener('pointerleave', revealToolbar);
  elements.pageNavigation.addEventListener('pointerenter', () => {
    clearTimeout(pageControlsHideTimer);
    elements.readerOverlay.classList.add('page-controls-visible');
  });
  elements.pageNavigation.addEventListener('pointerleave', revealPageControls);
  window.addEventListener('keydown', async (event) => {
    if (event.key !== 'Escape' || !state.currentBook || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    if (state.fullscreen) {
      try { applyFullscreenState(await window.readerApi.setFullscreen(false)); }
      catch (error) { showToast(errorMessage(error), 'error'); }
    } else {
      await closeReader();
    }
  });
  window.readerApi.onScanProgress((progress) => {
    if (progress.phase === 'collection') {
      elements.scanStatus.textContent = `正在扫描 ${progress.name} · ${progress.index + 1}/${progress.total}`;
      if (state.startupActive && progress.total > 0) {
        reportStartupProgress('正在扫描书库', 0.72 + (progress.index / progress.total) * 0.23);
      }
    }
  });
  window.readerApi.onArchiveProgress((progress) => reader.handleArchiveProgress(progress));
  window.readerApi.onFullscreenChange((value) => applyFullscreenState(value));
  document.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (state.currentBook) return;
    state.dragDepth += 1;
    elements.dropOverlay.classList.remove('hidden');
  });
  document.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (state.currentBook) return;
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (state.dragDepth === 0) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) elements.dropOverlay.classList.add('hidden');
  });
  document.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    elements.dropOverlay.classList.add('hidden');
    if (state.currentBook) return;
    acceptDroppedPaths(event);
  });
}

async function initialize() {
  cacheElements();
  refreshIcons();
  bindEvents();
  reportStartupProgress('正在读取配置', 0.58);
  try {
    await refreshPersistentState();
    renderAll();
    if (state.recoveryMode) {
      elements.scanStatus.textContent = state.pendingRenameRecovery ? '待处理重命名冲突' : '配置保护模式';
      reportStartupProgress('启动遇到问题', 1);
      openRenameRecoveryDialog();
    } else {
      reportStartupProgress('正在扫描书库', 0.72);
      await scanAll();
      reportStartupProgress('启动完成', 1);
    }
  } catch (error) {
    elements.scanStatus.textContent = '初始化失败';
    showToast(errorMessage(error), 'error', 6000);
    reportStartupProgress('启动遇到问题', 1);
  } finally {
    await window.readerApi.startupComplete().catch(() => {});
    state.startupActive = false;
  }
}

initialize();
