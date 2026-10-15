import ePub from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { pageWheelAction } from './page-wheel.js';
import { ComicLoadScheduler } from './comic-load-scheduler.js';
import { createPdfRangeSession } from './pdf-range-session.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const QUICK_GESTURE_DELAY_MS = 2000;
const COMIC_LOAD_CONCURRENCY = 2;
const COMIC_CACHE_MAX_PAGES = 18;
const COMIC_CACHE_MAX_DECODED_BYTES = 256 * 1024 * 1024;
const COMIC_SWAP_LOADING_DELAY_MS = 150;
const COMIC_BACKGROUND_PREFETCH_DELAY_MS = 0;

function toArrayBuffer(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function waitForImage(image) {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('图片页面无法显示。'));
  });
}

async function waitForImageDecode(image) {
  if (typeof image?.decode !== 'function') return;
  try {
    await image.decode();
  } catch (error) {
    if (!image.complete || !image.naturalWidth) throw error;
  }
}

async function decodeComicUrl(url) {
  const image = document.createElement('img');
  image.decoding = 'async';
  const loaded = waitForImage(image);
  image.src = url;
  await loaded;
  await waitForImageDecode(image);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export class ReaderController {
  constructor({
    onModeChange,
    onFitChange,
    onZoomChange,
    onEncodingChange,
    onNovelSettingsChange,
    onArchiveSaved,
    onArchiveLoaded,
    onError,
    getQuickGesturesEnabled,
    onToggleFullscreen,
    onCloseRequested
  }) {
    this.onModeChange = onModeChange;
    this.onFitChange = onFitChange;
    this.onZoomChange = onZoomChange;
    this.onEncodingChange = onEncodingChange;
    this.onNovelSettingsChange = onNovelSettingsChange;
    this.onArchiveSaved = onArchiveSaved;
    this.onArchiveLoaded = onArchiveLoaded;
    this.onError = onError;
    this.getQuickGesturesEnabled = getQuickGesturesEnabled || (() => false);
    this.onToggleFullscreen = onToggleFullscreen;
    this.onCloseRequested = onCloseRequested;
    this.overlay = document.querySelector('#readerOverlay');
    this.viewport = document.querySelector('#readerViewport');
    this.content = document.querySelector('#readerContent');
    this.loading = document.querySelector('#readerLoading');
    this.loadingText = document.querySelector('#readerLoadingText');
    this.modeControl = document.querySelector('#modeControl');
    this.fitControl = document.querySelector('#fitControl');
    this.zoomControl = document.querySelector('#zoomControl');
    this.zoomOutButton = document.querySelector('#zoomOutBtn');
    this.zoomInButton = document.querySelector('#zoomInBtn');
    this.zoomScaleLabel = document.querySelector('#zoomScaleLabel');
    this.encodingControl = document.querySelector('#encodingControl');
    this.encodingSelect = document.querySelector('#encodingSelect');
    this.novelControl = document.querySelector('#novelControl');
    this.eyeCareButton = document.querySelector('#eyeCareBtn');
    this.eyeCareLabel = document.querySelector('#eyeCareLabel');
    this.fontDecreaseButton = document.querySelector('#fontDecreaseBtn');
    this.fontIncreaseButton = document.querySelector('#fontIncreaseBtn');
    this.fontScaleLabel = document.querySelector('#fontScaleLabel');
    this.fontControls = document.querySelector('.font-controls');
    this.saveArchiveButton = document.querySelector('#saveArchiveBtn');
    this.loadArchiveButton = document.querySelector('#loadArchiveBtn');
    this.pageNavigation = document.querySelector('#pageNavigation');
    this.pageCounter = document.querySelector('#pageCounter');
    this.previousButton = document.querySelector('#prevPageBtn');
    this.nextButton = document.querySelector('#nextPageBtn');
    this.archiveProgress = document.querySelector('#archiveProgress');
    this.archiveProgressText = document.querySelector('#archiveProgressText');
    this.archiveProgressPercent = document.querySelector('#archiveProgressPercent');
    this.archiveProgressBar = document.querySelector('#archiveProgressBar');
    this.book = null;
    this.mode = 'continuous';
    this.fit = 'width';
    this.zoom = 100;
    this.pageIndex = 0;
    this.totalPages = 0;
    this.comicPages = [];
    this.comicCache = new Map();
    this.pdfCache = new Map();
    this.comicPendingPages = new Map();
    this.comicPendingTasks = new Map();
    this.comicPageStates = new Map();
    this.comicEncodedPages = new Set();
    this.comicEncodedPending = new Map();
    this.comicLoadScheduler = new ComicLoadScheduler({ concurrency: COMIC_LOAD_CONCURRENCY });
    this.pdfPendingPages = new Map();
    this.comicCacheVersion = 0;
    this.pdfCacheVersion = 0;
    this.visiblePages = new Set();
    this.observer = null;
    this.viewportObserver = null;
    this.pdfDocument = null;
    this.pdfLoadingTask = null;
    this.pdfRangeTransport = null;
    this.pdfSessionId = null;
    this.binaryAbortController = null;
    this.binaryRequestId = null;
    this.epubBook = null;
    this.epubRendition = null;
    this.epubFixedLayout = false;
    this.novel = { eyeCare: true, fontScale: 100 };
    this.savedArchive = null;
    this.generation = 0;
    this.pageRequest = 0;
    this.wheelLocked = false;
    this.activeArchiveReads = new Set();
    this.archiveListAbortController = null;
    this.archiveListRequestId = null;
    this.comicArchiveSessionId = null;
    this.comicBackgroundPrefetchAllowed = true;
    this.comicBackgroundPrefetchId = 0;
    this.comicBackgroundPrefetchPromise = null;
    this.comicBackgroundRestartTimer = null;
    this.comicSwapLoadingTimer = null;
    this.archiveProgressShowTimer = null;
    this.archiveProgressHideTimer = null;
    this.epubGestureCleanups = [];
    this.gestureTargets = new WeakSet();
    this.lastSecondaryPress = null;
    this.quickGesturesReadyAt = Number.POSITIVE_INFINITY;
    this.viewChanging = false;
    this.viewChangeId = 0;
    this.modeSwitchAnchor = null;
    this.textEncoding = null;

    this.modeControl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-reader-mode]');
      if (button) this.setMode(button.dataset.readerMode).catch(this.onError);
    });
    this.fitControl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-fit-mode]');
      if (button) this.setFit(button.dataset.fitMode).catch(this.onError);
    });
    this.zoomOutButton.addEventListener('click', () => this.adjustZoom(-10).catch(this.onError));
    this.zoomInButton.addEventListener('click', () => this.adjustZoom(10).catch(this.onError));
    this.encodingSelect.addEventListener('change', () => this.setEncoding(this.encodingSelect.value).catch(this.onError));
    this.eyeCareButton.addEventListener('click', () => this.toggleEyeCare().catch(this.onError));
    this.fontDecreaseButton.addEventListener('click', () => this.adjustFont(-10).catch(this.onError));
    this.fontIncreaseButton.addEventListener('click', () => this.adjustFont(10).catch(this.onError));
    this.saveArchiveButton.addEventListener('click', () => this.saveArchive().catch(this.onError));
    this.loadArchiveButton.addEventListener('click', () => this.loadArchive().catch(this.onError));
    this.previousButton.addEventListener('click', () => this.goPage(-1).catch(this.onError));
    this.nextButton.addEventListener('click', () => this.goPage(1).catch(this.onError));
    this.viewport.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
    this.bindGestureTarget(this.viewport);
    window.addEventListener('keydown', (event) => this.handleKey(event));

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (this.book?.type === 'pdf') {
          this.releasePdfCache();
          this.renderPdf().catch(this.onError);
        } else if (this.book?.type === 'comic') {
          this.applyComicFit();
        }
      }, 180);
    });
  }

  async open(book, settings) {
    await this.close();
    this.book = book;
    const openingBook = book;
    this.generation += 1;
    this.mode = ['comic', 'pdf'].includes(book.type) ? settings.readerMode[book.type] : 'continuous';
    this.fit = book.type === 'comic'
      ? this.comicFitForMode(this.mode)
      : book.type === 'pdf' ? settings.fitMode.pdf : 'width';
    this.zoom = book.type === 'comic' ? 100 : book.type === 'pdf' ? settings.zoomScale?.pdf || 100 : 100;
    this.textEncoding = book.type === 'text' ? settings.textEncodings[book.id] || null : null;
    this.novel = {
      eyeCare: settings.novel && Object.hasOwn(settings.novel, 'eyeCare')
        ? settings.novel.eyeCare === true
        : true,
      fontScale: Number.isInteger(settings.novel?.fontScale) ? settings.novel.fontScale : 100
    };
    this.savedArchive = null;
    this.pageIndex = 0;
    this.overlay.classList.remove('hidden');
    this.viewport.scrollTo({ top: 0, left: 0 });
    this.resetArchiveProgress();
    this.syncControls();
    this.showLoading(`正在打开 ${book.name}`);

    try {
      if (book.type === 'comic') await this.openComic();
      else if (book.type === 'text') await this.openText(this.textEncoding);
      else if (book.type === 'epub') await this.openEpub();
      else if (book.type === 'pdf') await this.openPdf();
      else throw new Error('没有可用的阅读器。');
      if (this.book !== openingBook || this.book.id !== book.id) return;
      this.savedArchive = await window.readerApi.getArchive(book.id).catch(() => null);
      this.syncControls();
      this.hideLoading();
      this.quickGesturesReadyAt = performance.now() + QUICK_GESTURE_DELAY_MS;
    } catch (error) {
      if (this.book === openingBook) await this.close();
      throw error;
    }
  }

  async close() {
    this.comicBackgroundPrefetchId += 1;
    this.comicBackgroundPrefetchPromise = null;
    this.comicEncodedPending.clear();
    clearTimeout(this.comicBackgroundRestartTimer);
    this.comicBackgroundRestartTimer = null;
    clearTimeout(this.comicSwapLoadingTimer);
    this.comicSwapLoadingTimer = null;
    if (this.binaryAbortController) {
      this.binaryAbortController.abort();
      if (this.binaryRequestId) window.readerApi.cancelBinary(this.binaryRequestId).catch(() => {});
      this.binaryAbortController = null;
      this.binaryRequestId = null;
    }
    if (this.archiveListAbortController) {
      this.archiveListAbortController.abort();
      if (this.archiveListRequestId) window.readerApi.cancelArchiveList(this.archiveListRequestId).catch(() => {});
      this.archiveListAbortController = null;
      this.archiveListRequestId = null;
    }
    this.generation += 1;
    this.pageRequest += 1;
    this.viewChangeId += 1;
    this.viewChanging = false;
    this.clearEpubGestureTargets();
    this.lastSecondaryPress = null;
    this.quickGesturesReadyAt = Number.POSITIVE_INFINITY;
    this.modeSwitchAnchor = null;
    this.disconnectObserver();
    await this.releaseComicCache();
    if (this.comicArchiveSessionId) {
      await window.readerApi.closeArchiveSession(this.comicArchiveSessionId).catch(() => {});
    }
    this.releasePdfCache();
    if (this.pdfRangeTransport) {
      try { this.pdfRangeTransport.abort(); } catch {}
    }
    if (this.pdfLoadingTask) {
      try { await this.pdfLoadingTask.destroy(); } catch {}
    }
    if (this.pdfSessionId) {
      await window.readerApi.cancelPdf(this.pdfSessionId).catch(() => {});
    }
    if (this.epubRendition) {
      try { this.epubRendition.destroy(); } catch {}
    }
    if (this.epubBook) {
      try { this.epubBook.destroy(); } catch {}
    }
    if (this.pdfDocument) {
      try { await this.pdfDocument.destroy(); } catch {}
    }
    this.epubRendition = null;
    this.epubBook = null;
    this.epubFixedLayout = false;
    this.savedArchive = null;
    this.textEncoding = null;
    this.pdfDocument = null;
    this.pdfLoadingTask = null;
    this.pdfRangeTransport = null;
    this.pdfSessionId = null;
    this.book = null;
    this.comicPages = [];
    this.comicEncodedPages.clear();
    this.comicArchiveSessionId = null;
    this.comicBackgroundPrefetchAllowed = true;
    this.content.replaceChildren();
    this.overlay.classList.add('hidden');
    this.overlay.classList.remove('page-controls-visible', 'toolbar-visible');
    this.hideLoading();
    this.resetArchiveProgress();
  }

  showLoading(message) {
    this.loadingText.textContent = message;
    this.loading.classList.remove('hidden');
  }

  hideLoading() {
    this.loading.classList.add('hidden');
  }

  syncControls() {
    const paged = ['comic', 'pdf'].includes(this.book?.type);
    const novel = ['text', 'epub'].includes(this.book?.type);
    const novelCustomizable = novel && !(this.book?.type === 'epub' && this.epubFixedLayout);
    const archiveVisible = novel || this.book?.type === 'comic';
    const archiveOperational = novelCustomizable || this.book?.type === 'comic';
    this.modeControl.classList.toggle('hidden', !paged);
    this.fitControl.classList.toggle('hidden', !paged);
    this.zoomControl.classList.toggle('hidden', !paged);
    this.novelControl.classList.toggle('hidden', !archiveVisible);
    this.eyeCareButton.classList.toggle('hidden', !novel);
    this.fontControls.classList.toggle('hidden', !novel);
    this.encodingControl.classList.toggle('hidden', this.book?.type !== 'text');
    this.pageNavigation.classList.toggle('hidden', !paged || this.mode !== 'page');
    this.modeControl.querySelectorAll('[data-reader-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.readerMode === this.mode);
      button.disabled = !paged || this.viewChanging;
    });
    this.fitControl.querySelectorAll('[data-fit-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.fitMode === this.fit);
      button.disabled = !paged || this.viewChanging;
    });
    this.zoomOutButton.disabled = !paged || this.viewChanging || this.zoom <= 50;
    this.zoomInButton.disabled = !paged || this.viewChanging || this.zoom >= 300;
    this.zoomScaleLabel.textContent = `${this.zoom}%`;
    this.eyeCareButton.classList.toggle('active', this.novel.eyeCare && novelCustomizable);
    this.eyeCareLabel.textContent = this.novel.eyeCare && novelCustomizable ? '退出护眼' : '护眼模式';
    this.eyeCareButton.setAttribute('aria-label', this.novel.eyeCare && novelCustomizable ? '退出护眼' : '护眼模式');
    this.eyeCareButton.disabled = !novelCustomizable;
    this.saveArchiveButton.classList.toggle('hidden', !archiveVisible);
    this.loadArchiveButton.classList.toggle('hidden', !archiveVisible);
    this.saveArchiveButton.disabled = !archiveVisible;
    this.loadArchiveButton.disabled = !archiveVisible || (archiveOperational && !this.savedArchive);
    this.saveArchiveButton.title = archiveOperational ? '保存存档' : '当前格式不可用';
    this.loadArchiveButton.title = archiveOperational ? (this.savedArchive ? '读档' : '暂无存档') : '当前格式不可用';
    this.fontDecreaseButton.disabled = !novelCustomizable || this.novel.fontScale <= 70;
    this.fontIncreaseButton.disabled = !novelCustomizable || this.novel.fontScale >= 200;
    this.fontScaleLabel.textContent = `${this.novel.fontScale}%`;
    const fixedTitle = novelCustomizable ? '' : '固定版式 EPUB 保留原有显示';
    this.eyeCareButton.title = fixedTitle;
    this.fontDecreaseButton.title = fixedTitle;
    this.fontIncreaseButton.title = fixedTitle;
    this.syncPageCounter();
  }

  syncPageCounter() {
    this.pageCounter.textContent = `${Math.min(this.pageIndex + 1, Math.max(this.totalPages, 1))} / ${Math.max(this.totalPages, 1)}`;
    this.previousButton.disabled = this.viewChanging || this.pageIndex <= 0;
    this.nextButton.disabled = this.viewChanging || this.pageIndex >= this.totalPages - 1;
  }

  capturePagedViewState() {
    return {
      book: this.book,
      mode: this.mode,
      fit: this.fit,
      zoom: this.zoom,
      pageIndex: this.pageIndex,
      scrollTop: this.viewport.scrollTop,
      scrollLeft: this.viewport.scrollLeft
    };
  }

  async restorePagedViewState(previous, operationId) {
    if (this.book !== previous.book || this.viewChangeId !== operationId) return;
    this.mode = previous.mode;
    this.fit = previous.fit;
    this.zoom = previous.zoom;
    this.pageIndex = previous.pageIndex;
    try {
      if (this.book.type === 'comic') {
        await this.renderComic();
      } else {
        this.releasePdfCache();
        await this.renderPdf();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (this.book === previous.book && this.viewChangeId === operationId) {
        this.viewport.scrollTo({ top: previous.scrollTop, left: previous.scrollLeft });
      }
    } catch {}
  }

  async setMode(mode, { persist = true } = {}) {
    if (this.viewChanging || !this.book || !['comic', 'pdf'].includes(this.book.type) || !['continuous', 'page'].includes(mode) || mode === this.mode) return;
    const previous = this.capturePagedViewState();
    const type = this.book.type;
    const operationId = ++this.viewChangeId;
    this.viewChanging = true;
    const modeSwitchAnchor = mode === 'continuous' && this.mode === 'page'
      ? {
        operationId,
        pageIndex: Math.max(0, Math.min(this.totalPages - 1, Number(previous.pageIndex) || 0)),
        offsetRatio: this.scrollRatio(previous.scrollTop, this.viewport.scrollHeight - this.viewport.clientHeight),
        scrollLeftRatio: this.scrollRatio(previous.scrollLeft, this.viewport.scrollWidth - this.viewport.clientWidth)
      }
      : null;
    this.modeSwitchAnchor = modeSwitchAnchor;
    if (mode === 'page' && this.mode === 'continuous') {
      const selector = this.book.type === 'comic' ? '.comic-page' : '.pdf-page';
      const currentScrollTop = this.viewport.scrollTop;
      const visiblePage = [...this.content.querySelectorAll(selector)]
        .filter((page) => page.offsetTop <= currentScrollTop + 2)
        .at(-1);
      this.pageIndex = visiblePage ? Number(visiblePage.dataset.pageIndex) || 0 : 0;
    }
    this.mode = mode;
    if (type === 'comic') {
      this.fit = this.comicFitForMode(mode);
      this.zoom = 100;
    }
    this.syncControls();
    this.showLoading('正在切换阅读模式');
    try {
      if (type === 'comic') await this.renderComic();
      else {
        this.releasePdfCache();
        await this.renderPdf();
      }
      if (this.book !== previous.book || this.viewChangeId !== operationId) return;
      if (modeSwitchAnchor) await this.restoreModeSwitchPosition(modeSwitchAnchor, operationId);
      if (this.book !== previous.book || this.viewChangeId !== operationId) return;
      if (persist) await this.onModeChange(type, mode);
    } catch (error) {
      if (this.book !== previous.book || this.viewChangeId !== operationId) return;
      await this.restorePagedViewState(previous, operationId);
      throw error;
    } finally {
      if (this.modeSwitchAnchor?.operationId === operationId) this.modeSwitchAnchor = null;
      if (this.viewChangeId === operationId) {
        this.hideLoading();
        this.viewChanging = false;
        this.syncControls();
      }
    }
  }

  isModeSwitchAnchorActive(operationId) {
    return Boolean(
      this.modeSwitchAnchor
      && this.modeSwitchAnchor.operationId === operationId
      && this.book
      && this.mode === 'continuous'
      && ['comic', 'pdf'].includes(this.book.type)
    );
  }

  syncModeSwitchAnchor(anchor = this.modeSwitchAnchor) {
    if (!anchor || !this.isModeSwitchAnchorActive(anchor.operationId)) return false;
    const selector = this.book.type === 'comic' ? '.comic-page' : '.pdf-page';
    const pageIndex = Math.max(0, Math.min(this.totalPages - 1, Number(anchor.pageIndex) || 0));
    const host = this.content.querySelector(`${selector}[data-page-index="${pageIndex}"]`);
    if (!host) return false;
    const offsetRatio = Math.max(0, Math.min(1, Number(anchor.offsetRatio) || 0));
    const top = host.offsetTop + offsetRatio * Math.max(0, host.offsetHeight - this.viewport.clientHeight);
    const left = Math.max(0, Math.min(1, Number(anchor.scrollLeftRatio) || 0))
      * Math.max(0, this.viewport.scrollWidth - this.viewport.clientWidth);
    this.viewport.scrollTo({ top: Math.max(0, top), left });
    this.pageIndex = pageIndex;
    this.syncPageCounter();
    return true;
  }

  async restoreModeSwitchPosition(anchor, operationId) {
    if (!this.isModeSwitchAnchorActive(operationId)) return;
    const selector = this.book.type === 'comic' ? '.comic-page' : '.pdf-page';
    const pageIndex = Math.max(0, Math.min(this.totalPages - 1, Number(anchor.pageIndex) || 0));
    const host = this.content.querySelector(`${selector}[data-page-index="${pageIndex}"]`);
    if (!host) return;
    if (this.book.type === 'comic') {
      await this.loadComicPage(pageIndex, host.querySelector('img'), this.generation, true);
    } else {
      await this.renderPdfPage(pageIndex, host, this.generation);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!this.isModeSwitchAnchorActive(operationId)) return;
      this.syncModeSwitchAnchor(anchor);
      const pending = this.book.type === 'comic'
        ? [...this.comicPendingPages.values()]
        : [...this.pdfPendingPages.values()];
      if (pending.length) await Promise.allSettled(pending);
    }
    this.syncModeSwitchAnchor(anchor);
  }

  async setFit(fit) {
    if (this.viewChanging || !this.book || !['comic', 'pdf'].includes(this.book.type) || !['width', 'height', 'fit'].includes(fit) || fit === this.fit) return;
    const previous = this.capturePagedViewState();
    const type = this.book.type;
    const operationId = ++this.viewChangeId;
    this.viewChanging = true;
    try {
      this.fit = fit;
      this.zoom = 100;
      this.syncControls();
      if (type === 'comic') {
        this.applyComicFit();
      } else {
        this.showLoading('正在调整页面');
        this.releasePdfCache();
        await this.renderPdf();
      }
      if (this.book !== previous.book || this.viewChangeId !== operationId) return;
      if (type === 'pdf') await this.onFitChange(type, fit, this.zoom);
    } catch (error) {
      if (this.book !== previous.book || this.viewChangeId !== operationId) return;
      await this.restorePagedViewState(previous, operationId);
      throw error;
    } finally {
      if (this.viewChangeId === operationId) {
        this.hideLoading();
        this.viewChanging = false;
        this.syncControls();
      }
    }
  }

  async adjustZoom(delta) {
    if (this.viewChanging || !this.book || !['comic', 'pdf'].includes(this.book.type)) return;
    const next = Math.min(300, Math.max(50, this.zoom + delta));
    if (next === this.zoom) return;
    const previous = this.capturePagedViewState();
    const type = this.book.type;
    const operationId = ++this.viewChangeId;
    this.viewChanging = true;
    try {
      this.zoom = next;
      this.syncControls();
      if (type === 'comic') {
        this.applyComicFit();
      } else {
        this.showLoading('正在调整页面');
        this.releasePdfCache();
        await this.renderPdf();
      }
      if (this.book !== previous.book || this.viewChangeId !== operationId) return;
      if (type === 'pdf') await this.onZoomChange(type, this.zoom);
    } catch (error) {
      if (this.book !== previous.book || this.viewChangeId !== operationId) return;
      await this.restorePagedViewState(previous, operationId);
      throw error;
    } finally {
      if (this.viewChangeId === operationId) {
        this.hideLoading();
        this.viewChanging = false;
        this.syncControls();
      }
    }
  }

  comicFitForMode(mode) {
    return mode === 'page' ? 'height' : 'width';
  }

  async setEncoding(value) {
    if (this.book?.type !== 'text') return;
    const encoding = value === 'auto' ? null : value;
    const previous = this.textEncoding;
    this.showLoading('正在重新读取文本');
    try {
      await this.openText(encoding);
      await this.onEncodingChange(this.book.id, encoding);
      this.textEncoding = encoding;
    } catch (error) {
      await this.openText(previous).catch(() => {});
      throw error;
    } finally {
      this.hideLoading();
    }
  }

  async openText(encoding) {
    const result = await window.readerApi.loadText(this.book.id, encoding);
    const pre = document.createElement('article');
    pre.className = 'text-reader';
    pre.textContent = result.text;
    this.content.replaceChildren(pre);
    this.content.className = 'reader-content';
    this.encodingSelect.value = encoding || 'auto';
    this.applyNovelAppearance();
    this.viewport.scrollTo({ top: 0, left: 0 });
  }

  async openEpub() {
    const bookId = this.book?.id;
    const generation = this.generation;
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const controller = new AbortController();
    this.binaryAbortController = controller;
    this.binaryRequestId = requestId;
    let bytes;
    try {
      bytes = await window.readerApi.loadBinary(this.book.id, 'epub', { requestId });
    } finally {
      if (this.binaryAbortController === controller) {
        this.binaryAbortController = null;
        this.binaryRequestId = null;
      }
    }
    if (controller.signal.aborted || !this.book || this.book.id !== bookId || generation !== this.generation) {
      throw Object.assign(new Error('EPUB 读取已停止。'), { code: 'EPUB_READ_CANCELLED' });
    }
    const host = document.createElement('div');
    host.className = 'epub-reader';
    this.content.className = 'reader-content';
    this.content.replaceChildren(host);
    this.epubBook = ePub(toArrayBuffer(bytes));
    await this.epubBook.ready;
    if (controller.signal.aborted || !this.book || this.book.id !== bookId || generation !== this.generation) {
      throw Object.assign(new Error('EPUB 读取已停止。'), { code: 'EPUB_READ_CANCELLED' });
    }
    this.epubFixedLayout = this.epubBook.packaging?.metadata?.layout === 'pre-paginated';
    this.epubRendition = this.epubBook.renderTo(host, {
      width: '100%',
      height: '100%',
      manager: 'continuous',
      flow: 'scrolled-doc',
      spread: 'none',
      allowScriptedContent: false
    });
    this.epubRendition.hooks.content.register((contents) => {
      if (contents?.document) this.bindGestureTarget(contents.document, true);
    });
    this.applyNovelAppearance();
    await this.epubRendition.display();
    if (!this.book || this.book.id !== bookId || generation !== this.generation) {
      throw Object.assign(new Error('EPUB 读取已停止。'), { code: 'EPUB_READ_CANCELLED' });
    }
    this.epubRendition.getContents().forEach((contents) => {
      if (contents?.document) this.bindGestureTarget(contents.document, true);
    });
    this.syncControls();
  }

  applyNovelAppearance() {
    if (this.book?.type === 'text') {
      const article = this.content.querySelector('.text-reader');
      if (!article) return;
      article.classList.toggle('eye-care', this.novel.eyeCare);
      article.style.fontSize = `${17 * this.novel.fontScale / 100}px`;
      return;
    }
    if (this.book?.type !== 'epub' || !this.epubRendition || this.epubFixedLayout) return;
    const common = {
      'font-family': '"Microsoft YaHei UI", sans-serif',
      'font-size': `${17 * this.novel.fontScale / 100}px`,
      'line-height': '1.9',
      padding: '28px 44px'
    };
    this.epubRendition.themes.register('reader-default', {
      body: { ...common, color: '#202421', background: '#f3f4f0' },
      img: { 'max-width': '100%', height: 'auto' },
      a: { color: '#24633a' }
    });
    this.epubRendition.themes.register('reader-eye-care', {
      body: { ...common, color: '#4a3825', background: '#eadfbe' },
      img: { 'max-width': '100%', height: 'auto' },
      a: { color: '#5e5426' }
    });
    this.epubRendition.themes.select(this.novel.eyeCare ? 'reader-eye-care' : 'reader-default');
  }

  async toggleEyeCare() {
    if (!['text', 'epub'].includes(this.book?.type) || this.epubFixedLayout) return;
    const previous = this.novel.eyeCare;
    this.novel.eyeCare = !this.novel.eyeCare;
    this.applyNovelAppearance();
    this.syncControls();
    try {
      await this.onNovelSettingsChange({ ...this.novel });
    } catch (error) {
      this.novel.eyeCare = previous;
      this.applyNovelAppearance();
      this.syncControls();
      throw error;
    }
  }

  async adjustFont(delta) {
    if (!['text', 'epub'].includes(this.book?.type) || this.epubFixedLayout) return;
    const next = Math.min(200, Math.max(70, this.novel.fontScale + delta));
    if (next === this.novel.fontScale) return;
    const previous = this.novel.fontScale;
    this.novel.fontScale = next;
    this.applyNovelAppearance();
    this.syncControls();
    try {
      await this.onNovelSettingsChange({ ...this.novel });
    } catch (error) {
      this.novel.fontScale = previous;
      this.applyNovelAppearance();
      this.syncControls();
      throw error;
    }
  }

  async saveArchive() {
    if (!['text', 'epub', 'comic'].includes(this.book?.type) || (this.book.type === 'epub' && this.epubFixedLayout)) {
      const error = new Error(this.book?.name ? `当前文件“${this.book.name}”不可进行存档：当前格式不可用。` : '当前格式不可用。');
      error.code = 'ARCHIVE_UNAVAILABLE';
      throw error;
    }
    const position = this.capturePosition();
    if (!position) return;
    this.savedArchive = await window.readerApi.saveArchive(this.book.id, position);
    this.syncControls();
    this.onArchiveSaved?.();
  }

  async loadArchive() {
    if (!['text', 'epub', 'comic'].includes(this.book?.type) || (this.book.type === 'epub' && this.epubFixedLayout)) {
      const error = new Error(this.book?.name ? `当前文件“${this.book.name}”不可进行读档：当前格式不可用。` : '当前格式不可用。');
      error.code = 'ARCHIVE_UNAVAILABLE';
      throw error;
    }
    const archive = this.savedArchive || await window.readerApi.getArchive(this.book.id);
    if (!archive) return;
    this.savedArchive = archive;
    if (
      this.book.type === 'comic'
      && ['continuous', 'page'].includes(archive.position?.mode)
      && archive.position.mode !== this.mode
    ) {
      await this.setMode(archive.position.mode, { persist: false });
    }
    if (this.book.type === 'comic') {
      this.fit = ['width', 'height', 'fit'].includes(archive.position?.fitMode)
        ? archive.position.fitMode
        : this.comicFitForMode(this.mode);
      this.zoom = Number.isFinite(Number(archive.position?.zoomScale))
        ? Math.min(300, Math.max(50, Math.round(Number(archive.position.zoomScale) / 10) * 10))
        : 100;
      this.syncControls();
      if (this.mode === 'continuous') {
        this.applyComicFit();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }
    await this.restorePosition(archive.position);
    this.onArchiveLoaded?.();
  }

  async openComic() {
    const bookId = this.book?.id;
    const generation = this.generation;
    const controller = new AbortController();
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}-comic`;
    this.archiveListAbortController = controller;
    this.archiveListRequestId = requestId;
    let pages;
    try {
      pages = await window.readerApi.listArchive(bookId, { requestId });
    } finally {
      if (this.archiveListAbortController === controller) {
        this.archiveListAbortController = null;
        this.archiveListRequestId = null;
      }
    }
    if (controller.signal.aborted || generation !== this.generation || this.book?.id !== bookId) {
      throw Object.assign(new Error('压缩包目录读取已取消。'), { code: 'ARCHIVE_READ_CANCELLED' });
    }
    const session = await window.readerApi.openArchiveSession(bookId, sessionId, pages);
    if (controller.signal.aborted || generation !== this.generation || this.book?.id !== bookId) {
      await window.readerApi.closeArchiveSession(sessionId).catch(() => {});
      throw Object.assign(new Error('压缩包目录读取已取消。'), { code: 'ARCHIVE_READ_CANCELLED' });
    }
    this.comicArchiveSessionId = sessionId;
    this.comicBackgroundPrefetchAllowed = session?.backgroundPrefetch !== false;
    this.comicPages = pages;
    this.totalPages = this.comicPages.length;
    this.syncControls();
    await this.renderComic();
  }

  async renderComic() {
    const generation = ++this.generation;
    this.comicBackgroundPrefetchId += 1;
    this.comicBackgroundPrefetchPromise = null;
    await this.cancelBackgroundComicLoads();
    this.pageRequest += 1;
    const staleTask = (task) => task.isStale();
    this.comicLoadScheduler.cancelPending(staleTask);
    await this.comicLoadScheduler.cancelActive(staleTask);
    await this.comicLoadScheduler.waitForIdle(staleTask);
    this.disconnectObserver();
    this.visiblePages.clear();
    this.comicPageStates.clear();
    this.content.replaceChildren();
    if (this.mode === 'page') {
      const stage = document.createElement('div');
      stage.className = `page-stage fit-${this.fit}`;
      stage.dataset.pageIndex = String(this.pageIndex);
      const image = document.createElement('img');
      image.alt = `第 ${this.pageIndex + 1} 页`;
      stage.append(image);
      this.ensureComicPageStatus(stage, this.pageIndex, image);
      this.content.className = 'reader-content page-mode';
      this.content.append(stage);
      await this.loadComicPage(this.pageIndex, image, generation, true);
      this.resetPageScroll(1);
      this.preloadComicNeighbors(generation);
    } else {
      const strip = document.createElement('div');
      strip.className = 'comic-continuous';
      this.content.className = `reader-content fit-${this.fit}`;
      const nodes = this.comicPages.map((page, index) => {
        const wrapper = document.createElement('figure');
        wrapper.className = 'comic-page';
        wrapper.dataset.pageIndex = String(index);
        const image = document.createElement('img');
        image.alt = `第 ${index + 1} 页`;
        wrapper.append(image);
        this.ensureComicPageStatus(wrapper, index, image);
        strip.append(wrapper);
        return wrapper;
      });
      this.content.append(strip);
      this.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.pageIndex);
          if (entry.isIntersecting) {
            const state = this.comicPageStates.get(index);
            if (state?.generation === generation && state.status === 'failed') continue;
            if (state?.generation === generation && (state.status === 'loading' || state.status === 'ready')) continue;
            this.loadComicPage(
              index,
              entry.target.querySelector('img'),
              generation,
              this.comicPageIsForeground(entry.target)
            ).catch(this.onError);
          }
        }
      }, { root: this.viewport, rootMargin: '120% 0px', threshold: 0.01 });
      this.viewportObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.pageIndex);
          if (entry.isIntersecting) {
            this.visiblePages.add(index);
            const state = this.comicPageStates.get(index);
            if (state?.generation === generation && state.status === 'failed' && state.foreground !== true) {
              this.loadComicPage(index, entry.target.querySelector('img'), generation, true).catch(this.onError);
            }
          } else this.visiblePages.delete(index);
        }
        const viewportTop = this.viewport.getBoundingClientRect().top;
        const current = nodes
          .filter((node) => this.visiblePages.has(Number(node.dataset.pageIndex)))
          .sort((a, b) => Math.abs(a.getBoundingClientRect().top - viewportTop) - Math.abs(b.getBoundingClientRect().top - viewportTop))[0];
        if (current && !this.modeSwitchAnchor) {
          this.pageIndex = Number(current.dataset.pageIndex) || 0;
          this.syncPageCounter();
        }
      }, { root: this.viewport, rootMargin: '0px', threshold: 0.01 });
      nodes.forEach((node) => this.observer.observe(node));
      nodes.forEach((node) => this.viewportObserver.observe(node));
      await this.loadComicPage(0, nodes[0].querySelector('img'), generation, true);
    }
    this.applyComicFit();
    this.syncPageCounter();
    this.startComicBackgroundPrefetch(generation);
  }

  applyComicFit() {
    if (!this.book || this.book.type !== 'comic') return;
    if (this.mode === 'page') {
      const stage = this.content.querySelector('.page-stage');
      if (stage) {
        stage.classList.remove('fit-width', 'fit-height', 'fit-fit');
        stage.classList.add(`fit-${this.fit}`);
      }
      this.content.className = 'reader-content page-mode';
    } else {
      this.content.className = `reader-content fit-${this.fit}`;
    }
    this.content.querySelectorAll('.comic-page img, .page-stage img').forEach((image) => this.applyComicImageSize(image));
  }

  ensureComicPageStatus(host, index, image, { onRetry = null } = {}) {
    if (!host) return null;
    let status = host.querySelector(':scope > .comic-page-status');
    if (!status) {
      status = document.createElement('div');
      status.className = 'comic-page-status';
      status.setAttribute('role', 'status');
      status.innerHTML = '<span class="comic-page-spinner" aria-hidden="true"></span><span class="comic-page-message">正在加载</span><button class="comic-page-retry" type="button" hidden>重新加载</button>';
      const retry = status.querySelector('.comic-page-retry');
      retry.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        status.retryAction?.();
      });
      host.append(status);
    }
    status.retryAction = onRetry || (() => {
      this.loadComicPage(index, image, this.generation, true, { retry: true }).catch(this.onError);
    });
    return status;
  }

  setComicPageStatus(image, state, error = null) {
    const host = image?.closest('.comic-page, .page-stage');
    if (!host) return;
    const status = this.ensureComicPageStatus(host, Number(host.dataset.pageIndex) || 0, image);
    const spinner = status.querySelector('.comic-page-spinner');
    const message = status.querySelector('.comic-page-message');
    const retry = status.querySelector('.comic-page-retry');
    host.classList.toggle('is-loading', state === 'loading');
    host.classList.toggle('is-failed', state === 'failed');
    host.classList.toggle('is-ready', state === 'ready');
    spinner.hidden = state !== 'loading';
    message.textContent = state === 'failed' ? '加载失败' : state === 'loading' ? '正在加载' : '';
    if (error?.message && state === 'failed') message.title = error.message;
    else message.removeAttribute('title');
    retry.hidden = state !== 'failed';
    image.hidden = state !== 'ready';
  }

  setComicSwapStatus(stage, state, error = null, onRetry = null) {
    const image = stage.querySelector(':scope > img');
    const status = this.ensureComicPageStatus(stage, this.pageIndex, image, { onRetry });
    const spinner = status.querySelector('.comic-page-spinner');
    const message = status.querySelector('.comic-page-message');
    const retry = status.querySelector('.comic-page-retry');
    stage.classList.toggle('is-swap-loading', state === 'loading');
    stage.classList.toggle('is-swap-failed', state === 'failed');
    spinner.hidden = state !== 'loading';
    message.textContent = state === 'failed' ? '加载失败' : state === 'loading' ? '正在加载' : '';
    if (error?.message && state === 'failed') message.title = error.message;
    else message.removeAttribute('title');
    retry.hidden = state !== 'failed';
  }

  comicPageIsForeground(host) {
    const page = host?.getBoundingClientRect?.();
    const viewport = this.viewport.getBoundingClientRect();
    return Boolean(page && page.bottom > viewport.top && page.top < viewport.bottom);
  }

  applyComicImageSize(image) {
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const pageMode = this.mode === 'page';
    const availableWidth = Math.max(160, this.viewport.clientWidth - (pageMode ? 108 : 56));
    const availableHeight = Math.max(180, this.viewport.clientHeight - (pageMode ? 96 : 34));
    let baseScale;
    if (this.fit === 'height') {
      baseScale = availableHeight / image.naturalHeight;
    } else if (this.fit === 'fit') {
      baseScale = Math.min(availableWidth / image.naturalWidth, availableHeight / image.naturalHeight);
    } else {
      baseScale = Math.min(pageMode ? availableWidth : 1180, availableWidth) / image.naturalWidth;
    }
    const scale = baseScale * this.zoom / 100;
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.maxWidth = 'none';
    image.style.maxHeight = 'none';
    const wrapper = image.closest('.comic-page');
    if (wrapper) {
      wrapper.style.width = `${width}px`;
      wrapper.style.minHeight = `${height}px`;
      wrapper.style.maxWidth = 'none';
    }
  }

  async loadComicPage(index, image, generation = this.generation, foreground = false, { retry = false } = {}) {
    if (!image || generation !== this.generation) return null;
    const host = image.closest('.comic-page, .page-stage');
    if (host) {
      host.dataset.pageIndex = String(index);
      this.ensureComicPageStatus(host, index, image);
    }
    if (retry) {
      this.discardComicPageCache(index, image);
      this.comicPageStates.delete(index);
    }
    this.comicPageStates.set(index, { generation, status: 'loading', foreground });
    this.setComicPageStatus(image, 'loading');
    let currentForeground = foreground;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const cached = await this.ensureComicPage(index, currentForeground, { refresh: retry && attempt === 0 });
        if (generation !== this.generation) return null;
        if (!cached) throw Object.assign(new Error('漫画页面读取已取消'), { code: 'ARCHIVE_READ_CANCELLED' });
        cached.last = performance.now();
        if (image.src !== cached.url) {
          const loaded = waitForImage(image);
          image.decoding = 'async';
          image.src = cached.url;
          await loaded;
        }
        await waitForImageDecode(image);
        if (generation !== this.generation) return null;
        this.comicPageStates.set(index, { generation, status: 'ready' });
        this.setComicPageStatus(image, 'ready');
        this.applyComicImageSize(image);
        this.syncModeSwitchAnchor();
        this.evictComicCache(index);
        if (currentForeground) this.scheduleComicBackgroundPrefetch(generation);
        return cached;
      } catch (error) {
        if (generation !== this.generation) return null;
        lastError = error;
        this.discardComicPageCache(index, image);
        if (attempt === 0 && (currentForeground || this.comicPageIsForeground(host))) {
          currentForeground = true;
          continue;
        }
        break;
      }
    }
    if (generation === this.generation) {
      this.comicPageStates.set(index, { generation, status: 'failed', error: lastError, foreground: currentForeground });
      this.setComicPageStatus(image, 'failed', lastError);
    }
    return null;
  }

  discardComicPageCache(index, image = null) {
    const cached = this.comicCache.get(index);
    if (!cached) return;
    if (image?.src === cached.url) image.removeAttribute('src');
    URL.revokeObjectURL(cached.url);
    this.comicCache.delete(index);
  }

  async ensureComicPage(index, foreground = false, { refresh = false } = {}) {
    let cached = this.comicCache.get(index);
    if (cached && !refresh) {
      cached.last = performance.now();
      return cached;
    }
    if (foreground) {
      const pendingBeforeCancel = this.comicPendingTasks.get(index);
      const pendingWasBackground = pendingBeforeCancel?.background === true;
      await this.cancelBackgroundComicLoads();
      if (pendingWasBackground) {
        const pending = this.comicPendingPages.get(index);
        if (pending) await pending.catch(() => null);
        await Promise.resolve();
      }
      cached = this.comicCache.get(index);
      if (cached && !refresh) {
        cached.last = performance.now();
        return cached;
      }
      if (this.comicPendingPages.has(index)) return this.comicPendingPages.get(index);
    } else if (this.comicEncodedPending.has(index)) {
      await this.comicEncodedPending.get(index).catch(() => false);
      cached = this.comicCache.get(index);
      if (cached && !refresh) {
        cached.last = performance.now();
        return cached;
      }
      if (this.comicPendingPages.has(index)) return this.comicPendingPages.get(index);
    }
    if (this.comicPendingPages.has(index)) {
      const task = this.comicPendingTasks.get(index);
      if (task) task.priority = Math.max(task.priority, this.comicLoadPriority(index, foreground));
      this.comicLoadScheduler.pump();
      return this.comicPendingPages.get(index);
    }
    const cacheVersion = this.comicCacheVersion;
    const generation = this.generation;
    const bookId = this.book?.id;
    const sessionId = this.comicArchiveSessionId;
    const stale = () => generation !== this.generation
      || cacheVersion !== this.comicCacheVersion
      || this.book?.id !== bookId
      || this.comicArchiveSessionId !== sessionId;
    let promise;
    const scheduled = this.comicLoadScheduler.enqueue(async (signal) => {
      const page = this.comicPages[index];
      if (!page || stale()) return null;
      const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      const cancelRequest = () => window.readerApi.cancelArchivePage(requestId).catch(() => {});
      signal.addEventListener('abort', cancelRequest, { once: true });
      let payload;
      try {
        payload = await window.readerApi.readArchivePage(bookId, page.name, {
          foreground,
          requestId,
          sessionId,
          refresh
        });
      } catch (error) {
        if (signal.aborted || error?.code === 'ARCHIVE_READ_CANCELLED' || stale()) return null;
        throw error;
      } finally {
        signal.removeEventListener('abort', cancelRequest);
      }
      if (stale()) return null;
      if (payload.sessionCached === true) this.comicEncodedPages.add(index);
      const blob = new Blob([new Uint8Array(payload.bytes)], { type: payload.mime });
      const url = URL.createObjectURL(blob);
      let entry = null;
      try {
        const dimensions = await decodeComicUrl(url);
        if (stale()) return null;
        entry = {
          url,
          last: performance.now(),
          decodedBytes: Math.max(0, dimensions.width * dimensions.height * 4)
        };
        this.comicCache.set(index, entry);
        this.evictComicCache(index);
        return entry;
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      } finally {
        if (stale() && !entry) URL.revokeObjectURL(url);
      }
    }, {
      priority: this.comicLoadPriority(index, foreground),
      isStale: stale,
      background: false
    });
    promise = scheduled.promise.finally(() => {
      if (this.comicPendingPages.get(index) === promise) this.comicPendingPages.delete(index);
      if (this.comicPendingTasks.get(index) === scheduled.item) this.comicPendingTasks.delete(index);
    });
    this.comicPendingPages.set(index, promise);
    this.comicPendingTasks.set(index, scheduled.item);
    return promise;
  }

  comicLoadPriority(index, foreground = false) {
    const distance = Math.abs(index - this.pageIndex);
    if (foreground) return 1000;
    if (this.mode === 'page') return distance === 0 ? 900 : distance === 1 ? 700 : 300 - Math.min(200, distance * 10);
    if (this.visiblePages.has(index)) return 800 - Math.min(300, distance * 15);
    return (index >= this.pageIndex ? 500 : 350) - Math.min(200, distance * 8);
  }

  refreshComicLoadPriorities() {
    for (const [index, task] of this.comicPendingTasks) {
      task.priority = this.comicLoadPriority(index, this.mode === 'page' && index === this.pageIndex);
    }
    this.comicLoadScheduler.pump();
  }

  async cancelBackgroundComicLoads() {
    this.comicBackgroundPrefetchId += 1;
    this.comicBackgroundPrefetchPromise = null;
    this.comicLoadScheduler.cancelPending((item) => item.background === true);
    await this.comicLoadScheduler.cancelActive((item) => item.background === true);
  }

  async ensureComicEncodedPage(index, generation = this.generation) {
    if (generation !== this.generation || index < 0 || index >= this.totalPages) return false;
    if (this.comicEncodedPages.has(index)) return true;
    if (this.comicEncodedPending?.has(index)) return this.comicEncodedPending.get(index);
    const sessionId = this.comicArchiveSessionId;
    const bookId = this.book?.id;
    const stale = () => generation !== this.generation
      || this.comicArchiveSessionId !== sessionId
      || this.book?.id !== bookId;
    const scheduled = this.comicLoadScheduler.enqueue(async (signal) => {
      if (stale() || signal.aborted) return false;
      const page = this.comicPages[index];
      const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      const cancelRequest = () => window.readerApi.cancelArchivePage(requestId).catch(() => {});
      signal.addEventListener('abort', cancelRequest, { once: true });
      let payload;
      try {
        payload = await window.readerApi.readArchivePage(bookId, page.name, {
          foreground: false,
          requestId,
          sessionId,
          cacheOnly: true
        });
      } catch (error) {
        if (signal.aborted || stale() || error?.code === 'ARCHIVE_READ_CANCELLED') return false;
        throw error;
      } finally {
        signal.removeEventListener('abort', cancelRequest);
      }
      if (stale() || signal.aborted) return false;
      if (payload?.sessionCached !== true) {
        if (payload?.sessionCacheStatus === 'space-low') this.comicBackgroundPrefetchAllowed = false;
        return false;
      }
      this.comicEncodedPages.add(index);
      return true;
    }, { priority: -100, isStale: stale, background: true });
    const promise = scheduled.promise.finally(() => {
      if (this.comicEncodedPending?.get(index) === promise) this.comicEncodedPending.delete(index);
    });
    if (!this.comicEncodedPending) this.comicEncodedPending = new Map();
    this.comicEncodedPending.set(index, promise);
    return promise;
  }

  startComicBackgroundPrefetch(generation = this.generation) {
    if (this.comicBackgroundPrefetchPromise
      || !this.comicArchiveSessionId
      || !this.comicBackgroundPrefetchAllowed) return;
    const runId = ++this.comicBackgroundPrefetchId;
    this.comicBackgroundPrefetchPromise = (async () => {
      const pending = new Set();
      let shouldContinue = true;
      const settleOne = async () => {
        if (pending.size === 0) return;
        await Promise.race(pending);
      };
      for (let index = 0; index < this.totalPages; index += 1) {
        if (runId !== this.comicBackgroundPrefetchId || generation !== this.generation) return;
        if (this.comicEncodedPages.has(index) || this.visiblePages.has(index) || this.comicPendingPages.has(index)) continue;
        const task = this.ensureComicEncodedPage(index, generation)
          .then((encoded) => {
            if (!encoded) shouldContinue = false;
            return encoded;
          })
          .catch(() => false)
          .finally(() => pending.delete(task));
        pending.add(task);
        if (pending.size >= COMIC_LOAD_CONCURRENCY) await settleOne();
        if (!shouldContinue || runId !== this.comicBackgroundPrefetchId || generation !== this.generation) {
          await Promise.allSettled(pending);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, COMIC_BACKGROUND_PREFETCH_DELAY_MS));
      }
      await Promise.allSettled(pending);
    })().finally(() => {
      if (runId === this.comicBackgroundPrefetchId) this.comicBackgroundPrefetchPromise = null;
    });
  }

  scheduleComicBackgroundPrefetch(generation = this.generation) {
    clearTimeout(this.comicBackgroundRestartTimer);
    this.comicBackgroundRestartTimer = setTimeout(() => {
      this.comicBackgroundRestartTimer = null;
      this.startComicBackgroundPrefetch(generation);
    }, 0);
  }

  evictComicCache(current) {
    const decodedBytes = () => [...this.comicCache.values()].reduce((sum, item) => sum + (Number(item.decodedBytes) || 0), 0);
    let totalBytes = decodedBytes();
    if (this.comicCache.size <= COMIC_CACHE_MAX_PAGES && totalBytes <= COMIC_CACHE_MAX_DECODED_BYTES) return;
    const displayed = Number(this.content.querySelector('.page-stage')?.dataset.pageIndex);
    const protectedPages = new Set([current, this.pageIndex, displayed]);
    if (this.mode === 'page') {
      protectedPages.add(this.pageIndex - 1);
      protectedPages.add(this.pageIndex + 1);
    }
    const candidates = [...this.comicCache.entries()]
      .filter(([index]) => !protectedPages.has(index) && !this.visiblePages.has(index))
      .sort((a, b) => a[1].last - b[1].last);
    while ((this.comicCache.size > COMIC_CACHE_MAX_PAGES || totalBytes > COMIC_CACHE_MAX_DECODED_BYTES) && candidates.length) {
      const [index, item] = candidates.shift();
      this.content.querySelectorAll(`[data-page-index="${index}"] img`).forEach((image) => {
        if (image.src === item.url) image.removeAttribute('src');
      });
      URL.revokeObjectURL(item.url);
      this.comicCache.delete(index);
      this.comicPageStates.delete(index);
      totalBytes -= Number(item.decodedBytes) || 0;
    }
  }

  async releaseComicCache() {
    this.comicCacheVersion += 1;
    this.comicLoadScheduler.cancelPending();
    await this.comicLoadScheduler.cancelActive();
    await this.comicLoadScheduler.waitForIdle();
    for (const item of this.comicCache.values()) URL.revokeObjectURL(item.url);
    this.comicCache.clear();
    this.comicPendingPages.clear();
    this.comicPendingTasks.clear();
    this.comicPageStates.clear();
    this.visiblePages.clear();
  }

  preloadComicNeighbors(generation) {
    for (const index of [this.pageIndex - 1, this.pageIndex + 1]) {
      if (generation !== this.generation || index < 0 || index >= this.totalPages || this.comicCache.has(index) || this.comicPendingPages.has(index)) continue;
      this.ensureComicPage(index, false).catch(this.onError);
    }
  }

  async openPdf() {
    const bookId = this.book?.id;
    const generation = this.generation;
    const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const metadata = await window.readerApi.openPdf(bookId, sessionId);
    if (!this.book || this.book.id !== bookId || generation !== this.generation) {
      await window.readerApi.cancelPdf(sessionId).catch(() => {});
      throw Object.assign(new Error('PDF 读取已停止。'), { code: 'PDF_READ_CANCELLED' });
    }
    this.pdfSessionId = sessionId;
    const rangeSession = createPdfRangeSession({
      pdfjsLib,
      readerApi: window.readerApi,
      bookId,
      sessionId,
      metadata,
      isCurrent: () => this.pdfSessionId === sessionId && this.book?.id === bookId,
      onFatalError: (error) => {
        if (this.pdfDocument) this.onError(error);
      }
    });
    const { transport, task } = rangeSession;
    this.pdfRangeTransport = transport;
    this.pdfLoadingTask = task;
    let passwordProtected = false;
    task.onPassword = () => {
      passwordProtected = true;
      task.destroy();
    };
    try {
      this.pdfDocument = await task.promise;
      if (!this.book || this.book.id !== bookId || generation !== this.generation) {
        throw Object.assign(new Error('PDF 读取已停止。'), { code: 'PDF_READ_CANCELLED' });
      }
    } catch (error) {
      await rangeSession.waitForFailureShutdown();
      if (rangeSession.failure) throw rangeSession.failure;
      if (this.pdfSessionId !== sessionId || error?.name === 'AbortException' || error?.code === 'PDF_READ_CANCELLED') {
        throw Object.assign(new Error('PDF 读取已停止。'), { code: 'PDF_READ_CANCELLED' });
      }
      if (passwordProtected || error?.name === 'PasswordException') {
        const protectedError = new Error('该 PDF 受密码保护，首版不支持读取。');
        protectedError.code = 'ENCRYPTED_CONTENT';
        throw protectedError;
      }
      throw new Error('PDF 文件损坏或无法读取。');
    }
    this.totalPages = this.pdfDocument.numPages;
    this.syncControls();
    await this.renderPdf();
  }

  async renderPdf() {
    if (!this.pdfDocument) return;
    const generation = ++this.generation;
    this.pageRequest += 1;
    this.disconnectObserver();
    this.content.replaceChildren();
    if (this.mode === 'page') {
      const stage = document.createElement('div');
      stage.className = `pdf-page-stage fit-${this.fit}`;
      stage.dataset.pageIndex = String(this.pageIndex);
      this.content.className = 'reader-content page-mode';
      this.content.append(stage);
      await this.renderPdfPage(this.pageIndex, stage, generation);
      this.preloadPdfNeighbors(generation);
    } else {
      const strip = document.createElement('div');
      strip.className = 'pdf-continuous';
      this.content.className = 'reader-content';
      const nodes = [];
      for (let index = 0; index < this.totalPages; index += 1) {
        const wrapper = document.createElement('figure');
        wrapper.className = 'pdf-page';
        wrapper.dataset.pageIndex = String(index);
        strip.append(wrapper);
        nodes.push(wrapper);
      }
      this.content.append(strip);
      this.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.pageIndex);
          if (entry.isIntersecting) {
            this.visiblePages.add(index);
            this.renderPdfPage(index, entry.target, generation).catch(this.onError);
          } else {
            this.visiblePages.delete(index);
          }
        }
        const viewportTop = this.viewport.getBoundingClientRect().top;
        const current = nodes
          .filter((node) => this.visiblePages.has(Number(node.dataset.pageIndex)))
          .sort((a, b) => Math.abs(a.getBoundingClientRect().top - viewportTop) - Math.abs(b.getBoundingClientRect().top - viewportTop))[0];
        if (current && !this.modeSwitchAnchor) {
          this.pageIndex = Number(current.dataset.pageIndex) || 0;
          this.syncPageCounter();
        }
      }, { root: this.viewport, rootMargin: '100% 0px', threshold: 0.01 });
      nodes.forEach((node) => this.observer.observe(node));
      await this.renderPdfPage(0, nodes[0], generation);
    }
    this.syncPageCounter();
  }

  async renderPdfPage(index, host, generation = this.generation) {
    if (!host || generation !== this.generation) return;
    const cached = await this.ensurePdfPage(index);
    if (!cached || generation !== this.generation) return;
    cached.last = performance.now();
    host.style.minWidth = cached.canvas.style.width;
    host.style.minHeight = cached.canvas.style.height;
    host.replaceChildren(cached.canvas);
    this.syncModeSwitchAnchor();
    this.evictPdfCache(index);
  }

  async ensurePdfPage(index) {
    const cached = this.pdfCache.get(index);
    if (cached) {
      cached.last = performance.now();
      return cached;
    }
    if (this.pdfPendingPages.has(index)) return this.pdfPendingPages.get(index);
    const cacheVersion = this.pdfCacheVersion;
    let promise;
    promise = (async () => {
      const page = await this.pdfDocument.getPage(index + 1);
      if (cacheVersion !== this.pdfCacheVersion) return null;
      const base = page.getViewport({ scale: 1 });
      const width = Math.max(320, this.viewport.clientWidth - (this.mode === 'page' ? 112 : 64));
      const height = Math.max(420, this.viewport.clientHeight - 92);
      const widthScale = width / base.width;
      const heightScale = height / base.height;
      const baseScale = this.fit === 'height' ? heightScale : this.fit === 'fit' ? Math.min(widthScale, heightScale) : widthScale;
      const scale = baseScale * this.zoom / 100;
      const displayViewport = page.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(displayViewport.width * pixelRatio);
      canvas.height = Math.floor(displayViewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(displayViewport.width)}px`;
      canvas.style.height = `${Math.floor(displayViewport.height)}px`;
      const context = canvas.getContext('2d', { alpha: false });
      const renderTask = page.render({
        canvasContext: context,
        viewport: displayViewport,
        transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0]
      });
      await renderTask.promise;
      if (cacheVersion !== this.pdfCacheVersion) {
        canvas.width = 1;
        canvas.height = 1;
        return null;
      }
      const entry = { canvas, last: performance.now() };
      this.pdfCache.set(index, entry);
      this.evictPdfCache(this.pageIndex);
      return entry;
    })().finally(() => {
      if (this.pdfPendingPages.get(index) === promise) this.pdfPendingPages.delete(index);
    });
    this.pdfPendingPages.set(index, promise);
    return promise;
  }

  evictPdfCache(current) {
    if (this.pdfCache.size <= 8) return;
    const displayed = Number(this.content.querySelector('.pdf-page-stage')?.dataset.pageIndex);
    const candidates = [...this.pdfCache.entries()]
      .filter(([index]) => index !== current && index !== displayed && !this.visiblePages.has(index))
      .sort((a, b) => a[1].last - b[1].last);
    while (this.pdfCache.size > 8 && candidates.length) {
      const [index, item] = candidates.shift();
      item.canvas.width = 1;
      item.canvas.height = 1;
      this.pdfCache.delete(index);
    }
  }

  preloadPdfNeighbors(generation) {
    for (const index of [this.pageIndex - 1, this.pageIndex + 1]) {
      if (generation !== this.generation || index < 0 || index >= this.totalPages || this.pdfCache.has(index) || this.pdfPendingPages.has(index)) continue;
      this.ensurePdfPage(index).catch(this.onError);
    }
  }

  releasePdfCache() {
    this.pdfCacheVersion += 1;
    for (const item of this.pdfCache.values()) {
      item.canvas.width = 1;
      item.canvas.height = 1;
    }
    this.pdfCache.clear();
    this.pdfPendingPages.clear();
    this.visiblePages.clear();
  }

  disconnectObserver() {
    if (this.observer) this.observer.disconnect();
    if (this.viewportObserver) this.viewportObserver.disconnect();
    this.observer = null;
    this.viewportObserver = null;
  }

  async goPage(delta) {
    if (!this.book || this.mode !== 'page') return;
    const next = Math.max(0, Math.min(this.totalPages - 1, this.pageIndex + delta));
    if (next === this.pageIndex) return;
    const previous = this.pageIndex;
    const request = ++this.pageRequest;
    this.resetArchiveProgress();
    this.pageIndex = next;
    this.refreshComicLoadPriorities();
    this.syncPageCounter();
    try {
      if (this.book.type === 'comic') await this.showComicPage(next, request);
      else if (this.book.type === 'pdf') await this.showPdfPage(next, request);
      if (request !== this.pageRequest) return;
      this.resetPageScroll(delta);
    } catch (error) {
      if (request === this.pageRequest) {
        this.pageIndex = previous;
        this.syncPageCounter();
      }
      throw error;
    }
  }

  async showComicPage(index, request, { refresh = false } = {}) {
    const stage = this.content.querySelector('.page-stage');
    if (!stage) return;
    const generation = this.generation;
    const retry = () => {
      if (this.mode !== 'page' || this.pageIndex !== index) return;
      const retryRequest = ++this.pageRequest;
      this.resetArchiveProgress();
      this.showComicPage(index, retryRequest, { refresh: true }).catch(this.onError);
    };
    clearTimeout(this.comicSwapLoadingTimer);
    this.setComicSwapStatus(stage, 'idle', null, retry);
    this.comicPageStates.set(index, { generation, status: 'loading', foreground: true });
    this.comicSwapLoadingTimer = setTimeout(() => {
      if (request === this.pageRequest && generation === this.generation && this.mode === 'page') {
        this.setComicSwapStatus(stage, 'loading', null, retry);
      }
    }, COMIC_SWAP_LOADING_DELAY_MS);

    try {
      if (refresh) {
        this.discardComicPageCache(index);
        this.comicEncodedPages.delete(index);
      }
      const cached = await this.ensureComicPage(index, true, { refresh });
      if (!cached) throw Object.assign(new Error('漫画页面读取已取消'), { code: 'ARCHIVE_READ_CANCELLED' });
      const image = document.createElement('img');
      image.alt = `第 ${index + 1} 页`;
      image.decoding = 'async';
      const loaded = waitForImage(image);
      image.src = cached.url;
      await loaded;
      await waitForImageDecode(image);
      if (request !== this.pageRequest || generation !== this.generation || this.mode !== 'page') return;
      clearTimeout(this.comicSwapLoadingTimer);
      this.comicSwapLoadingTimer = null;
      stage.classList.remove('is-swap-loading', 'is-swap-failed');
      cached.last = performance.now();
      stage.dataset.pageIndex = String(index);
      stage.replaceChildren(image);
      this.ensureComicPageStatus(stage, index, image);
      this.comicPageStates.set(index, { generation, status: 'ready' });
      this.setComicPageStatus(image, 'ready');
      this.applyComicImageSize(image);
      this.evictComicCache(index);
      this.preloadComicNeighbors(generation);
      this.startComicBackgroundPrefetch(generation);
    } catch (error) {
      if (request !== this.pageRequest || generation !== this.generation || this.mode !== 'page') return;
      clearTimeout(this.comicSwapLoadingTimer);
      this.comicSwapLoadingTimer = null;
      if (error?.code === 'ARCHIVE_READ_CANCELLED') return;
      this.comicPageStates.set(index, { generation, status: 'failed', error, foreground: true });
      this.setComicSwapStatus(stage, 'failed', error, retry);
    }
  }

  async showPdfPage(index, request) {
    const stage = this.content.querySelector('.pdf-page-stage');
    if (!stage) return;
    const cached = await this.ensurePdfPage(index);
    if (!cached || request !== this.pageRequest || this.mode !== 'page') return;
    cached.last = performance.now();
    stage.dataset.pageIndex = String(index);
    stage.style.minWidth = cached.canvas.style.width;
    stage.style.minHeight = cached.canvas.style.height;
    stage.replaceChildren(cached.canvas);
    this.evictPdfCache(index);
    this.preloadPdfNeighbors(this.generation);
  }

  handleWheel(event) {
    if (!this.book || this.mode !== 'page' || !['comic', 'pdf'].includes(this.book.type)) return;
    const action = pageWheelAction({
      deltaY: event.deltaY,
      scrollTop: this.viewport.scrollTop,
      scrollHeight: this.viewport.scrollHeight,
      clientHeight: this.viewport.clientHeight
    });
    if (action === 'ignore' || action === 'scroll') return;
    event.preventDefault();
    if (this.wheelLocked) return;
    this.wheelLocked = true;
    this.goPage(action === 'next' ? 1 : -1).catch(this.onError).finally(() => {
      setTimeout(() => { this.wheelLocked = false; }, 160);
    });
  }

  resetPageScroll(direction) {
    requestAnimationFrame(() => {
      this.viewport.scrollTop = direction < 0
        ? Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight)
        : 0;
      this.viewport.scrollLeft = 0;
    });
  }

  capturePosition() {
    if (!this.book) return null;
    if (this.mode === 'page' && ['comic', 'pdf'].includes(this.book.type)) {
      const position = {
        kind: 'page',
        pageIndex: this.pageIndex,
        scrollTop: this.viewport.scrollTop,
        scrollLeft: this.viewport.scrollLeft
      };
      if (this.book.type === 'comic') {
        position.mode = 'page';
        position.fitMode = this.fit;
        position.zoomScale = this.zoom;
        position.scrollTopRatio = this.scrollRatio(this.viewport.scrollTop, this.viewport.scrollHeight - this.viewport.clientHeight);
        position.scrollLeftRatio = this.scrollRatio(this.viewport.scrollLeft, this.viewport.scrollWidth - this.viewport.clientWidth);
      }
      return position;
    }
    if (this.book.type === 'epub' && this.epubRendition) {
      const location = this.epubRendition.currentLocation();
      const cfi = Array.isArray(location) ? location[0]?.start?.cfi : location?.start?.cfi;
      if (cfi) return { kind: 'epub', cfi };
    }
    if (this.mode === 'continuous' && ['comic', 'pdf'].includes(this.book.type)) {
      const selector = this.book.type === 'comic' ? '.comic-page' : '.pdf-page';
      const pages = [...this.content.querySelectorAll(selector)];
      const scrollTop = this.viewport.scrollTop;
      const anchor = pages.reduce((current, page) => page.offsetTop <= scrollTop + 1 ? page : current, pages[0]);
      if (anchor) {
        const position = {
          kind: 'continuous-page',
          pageIndex: Number(anchor.dataset.pageIndex) || 0,
          offset: scrollTop - anchor.offsetTop,
          scrollLeft: this.viewport.scrollLeft
        };
        if (this.book.type === 'comic') {
          position.mode = 'continuous';
          position.fitMode = this.fit;
          position.zoomScale = this.zoom;
          position.offsetRatio = this.scrollRatio(scrollTop - anchor.offsetTop, anchor.offsetHeight);
          position.scrollLeftRatio = this.scrollRatio(this.viewport.scrollLeft, this.viewport.scrollWidth - this.viewport.clientWidth);
        }
        return position;
      }
    }
    return { kind: 'scroll', scrollTop: this.viewport.scrollTop, scrollLeft: this.viewport.scrollLeft };
  }

  async restorePosition(position) {
    if (!this.book || !position) return;
    if (position.kind === 'page' && this.mode === 'page' && ['comic', 'pdf'].includes(this.book.type)) {
      this.pageIndex = Math.max(0, Math.min(this.totalPages - 1, Number(position.pageIndex) || 0));
      if (this.book.type === 'comic') await this.renderComic();
      else await this.renderPdf();
    } else if (position.kind === 'epub' && this.book.type === 'epub' && this.epubRendition) {
      await this.epubRendition.display(position.cfi);
      return;
    } else if (position.kind === 'continuous-page' && this.mode === 'continuous' && ['comic', 'pdf'].includes(this.book.type)) {
      const pageIndex = Math.max(0, Math.min(this.totalPages - 1, Number(position.pageIndex) || 0));
      const selector = this.book.type === 'comic' ? '.comic-page' : '.pdf-page';
      const host = this.content.querySelector(`${selector}[data-page-index="${pageIndex}"]`);
      if (host) {
        if (this.book.type === 'comic') {
          await this.loadComicPage(pageIndex, host.querySelector('img'), this.generation);
        } else {
          await this.renderPdfPage(pageIndex, host, this.generation);
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const top = Number.isFinite(Number(position.offsetRatio))
          ? host.offsetTop + Math.max(0, Math.min(1, Number(position.offsetRatio))) * host.offsetHeight
          : host.offsetTop + (Number(position.offset) || 0);
        const left = Number.isFinite(Number(position.scrollLeftRatio))
          ? Math.max(0, Math.min(1, Number(position.scrollLeftRatio))) * Math.max(0, this.viewport.scrollWidth - this.viewport.clientWidth)
          : Math.max(0, Number(position.scrollLeft) || 0);
        this.viewport.scrollTo({
          top: Math.max(0, top),
          left
        });
        return;
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const top = Number.isFinite(Number(position.scrollTopRatio))
      ? Math.max(0, Math.min(1, Number(position.scrollTopRatio))) * Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight)
      : Math.max(0, Number(position.scrollTop) || 0);
    const left = Number.isFinite(Number(position.scrollLeftRatio))
      ? Math.max(0, Math.min(1, Number(position.scrollLeftRatio))) * Math.max(0, this.viewport.scrollWidth - this.viewport.clientWidth)
      : Math.max(0, Number(position.scrollLeft) || 0);
    this.viewport.scrollTo({
      top,
      left
    });
  }

  scrollRatio(value, maximum) {
    const max = Math.max(0, Number(maximum) || 0);
    if (max === 0) return 0;
    return Math.max(0, Math.min(1, (Number(value) || 0) / max));
  }

  handleArchiveProgress(progress) {
    if (!this.book || this.book.type !== 'comic' || progress.bookId !== this.book.id) return;
    if (this.mode === 'page' && this.comicPages[this.pageIndex]?.name !== progress.entryName) return;
    const key = progress.entryName;
    clearTimeout(this.archiveProgressHideTimer);
    if (progress.phase === 'start') this.activeArchiveReads.add(key);
    if (progress.phase === 'complete' || progress.phase === 'error') this.activeArchiveReads.delete(key);
    const total = Math.max(0, Number(progress.totalBytes) || 0);
    const loaded = Math.max(0, Number(progress.loadedBytes) || 0);
    const percent = progress.phase === 'complete' ? 100 : total > 0 ? Math.min(99, Math.round(loaded / total * 100)) : 0;
    const page = this.comicPages.findIndex((item) => item.name === progress.entryName);
    this.archiveProgressText.textContent = page >= 0
      ? `正在读取第 ${page + 1} / ${this.comicPages.length} 页`
      : '正在读取页面';
    this.archiveProgressPercent.textContent = `${percent}%`;
    this.archiveProgressBar.style.width = `${percent}%`;
    if (this.activeArchiveReads.size > 0) {
      if (!this.archiveProgressShowTimer) {
        this.archiveProgressShowTimer = setTimeout(() => {
          this.archiveProgressShowTimer = null;
          if (this.activeArchiveReads.size > 0) this.archiveProgress.classList.remove('hidden');
        }, 120);
      }
    } else if (progress.phase === 'progress') {
      clearTimeout(this.archiveProgressShowTimer);
      this.archiveProgressShowTimer = null;
      this.archiveProgress.classList.remove('hidden');
      this.archiveProgressHideTimer = setTimeout(() => this.archiveProgress.classList.add('hidden'), 650);
    } else {
      clearTimeout(this.archiveProgressShowTimer);
      this.archiveProgressShowTimer = null;
      this.archiveProgressHideTimer = setTimeout(() => this.archiveProgress.classList.add('hidden'), 650);
    }
  }

  resetArchiveProgress() {
    clearTimeout(this.archiveProgressShowTimer);
    this.archiveProgressShowTimer = null;
    clearTimeout(this.archiveProgressHideTimer);
    this.activeArchiveReads.clear();
    this.archiveProgress.classList.add('hidden');
    this.archiveProgressPercent.textContent = '0%';
    this.archiveProgressBar.style.width = '0%';
  }

  bindGestureTarget(target, ephemeral = false) {
    if (!target || this.gestureTargets.has(target)) return;
    this.gestureTargets.add(target);
    const onDoubleClick = (event) => {
      if (!this.quickGestureAllowed(event) || event.button !== 0) return;
      event.preventDefault();
      (target.getSelection?.() || target.ownerDocument?.getSelection?.())?.removeAllRanges?.();
      this.runGesture(this.onToggleFullscreen);
    };
    const onMouseDown = (event) => {
      if (!this.quickGestureAllowed(event) || event.button !== 2) return;
      event.preventDefault();
      const current = {
        target,
        time: Number(event.timeStamp) || performance.now(),
        x: Number(event.clientX) || 0,
        y: Number(event.clientY) || 0
      };
      const previous = this.lastSecondaryPress;
      const rapid = previous
        && previous.target === target
        && current.time - previous.time > 0
        && current.time - previous.time <= 420
        && Math.hypot(current.x - previous.x, current.y - previous.y) <= 12;
      this.lastSecondaryPress = rapid ? null : current;
      if (rapid) this.runGesture(this.onCloseRequested);
    };
    const onContextMenu = (event) => {
      if (this.quickGesturesReady()) event.preventDefault();
    };
    target.addEventListener('dblclick', onDoubleClick);
    target.addEventListener('mousedown', onMouseDown);
    target.addEventListener('contextmenu', onContextMenu);
    if (ephemeral) {
      this.epubGestureCleanups.push(() => {
        target.removeEventListener('dblclick', onDoubleClick);
        target.removeEventListener('mousedown', onMouseDown);
        target.removeEventListener('contextmenu', onContextMenu);
      });
    }
  }

  clearEpubGestureTargets() {
    this.epubGestureCleanups.splice(0).forEach((cleanup) => cleanup());
  }

  quickGestureAllowed(event) {
    if (!this.quickGesturesReady() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    return !event.target?.closest?.('button, input, select, textarea, a, [contenteditable="true"], [contenteditable=""]');
  }

  quickGesturesReady() {
    return Boolean(this.book && this.getQuickGesturesEnabled() && performance.now() >= this.quickGesturesReadyAt);
  }

  runGesture(callback) {
    if (typeof callback !== 'function') return;
    try {
      Promise.resolve(callback()).catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }

  isPageMode() {
    return Boolean(this.book && this.mode === 'page' && ['comic', 'pdf'].includes(this.book.type));
  }

  handleKey(event) {
    if (!this.book || event.defaultPrevented || this.isTypingTarget(event.target) || event.target?.closest?.('dialog[open]')) return;
    const key = String(event.key || '').toLowerCase();
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && (key === 's' || key === 'l')) {
      event.preventDefault();
      (key === 's' ? this.saveArchive() : this.loadArchive()).catch(this.onError);
      return;
    }
    if (this.mode !== 'page' || !['comic', 'pdf'].includes(this.book.type)) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      this.goPage(1).catch(this.onError);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      this.goPage(-1).catch(this.onError);
    }
  }

  isTypingTarget(target) {
    return Boolean(target?.closest?.('input, select, textarea, [contenteditable="true"], [contenteditable=""]'));
  }
}
