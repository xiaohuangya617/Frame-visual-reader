const fs = require('node:fs');
const fsp = require('node:fs/promises');
const chardet = require('chardet');
const iconv = require('iconv-lite');
const { AppError } = require('./app-error.cjs');

const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const PDF_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const PDF_MAX_RANGE_BYTES = 8 * 1024 * 1024;
const PDF_RANGE_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
const PDF_RANGE_TIMEOUT_MS = 30_000;
const MANUAL_ENCODINGS = Object.freeze({
  utf8: 'utf8',
  'utf-8': 'utf8',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  big5: 'big5'
});

function normalizeDetectedEncoding(value) {
  const normalized = String(value || '').toLocaleLowerCase('en-US').replace(/[_\s]/g, '-');
  if (normalized === 'utf-8' || normalized === 'utf8' || normalized === 'ascii') return 'utf8';
  if (normalized.includes('gb') || normalized.includes('cp936')) return 'gb18030';
  if (normalized.includes('big5')) return 'big5';
  return 'utf8';
}

function validRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function readerCancelled(code, message) {
  return new AppError(code, message);
}

async function readStreamBytes(filePath, {
  start = 0,
  end = null,
  maxBytes,
  signal = null,
  timeoutMs = 0,
  cancelledCode,
  cancelledMessage,
  timeoutCode = null,
  timeoutMessage = null
}) {
  if (signal?.aborted) throw readerCancelled(cancelledCode, cancelledMessage);
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  const timeoutHandle = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;
  const options = {
    start,
    signal: controller.signal,
    highWaterMark: 256 * 1024
  };
  if (end !== null) options.end = end - 1;
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of fs.createReadStream(filePath, options)) {
      total += chunk.length;
      if (total > maxBytes) {
        controller.abort();
        throw new AppError('FILE_TOO_LARGE', '文件超过允许的读取大小。');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (timedOut) throw new AppError(timeoutCode, timeoutMessage);
    if (signal?.aborted || error?.name === 'AbortError') {
      throw readerCancelled(cancelledCode, cancelledMessage);
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    signal?.removeEventListener('abort', relayAbort);
  }
}

class ReaderService {
  constructor(library, archive) {
    this.library = library;
    this.archive = archive;
    this.pdfSessions = new Map();
  }

  async loadText(bookId, requestedEncoding = null) {
    const book = this.library.getBook(bookId);
    if (book.type !== 'text') throw new AppError('WRONG_BOOK_TYPE', '该文件不是 TXT 文本。');
    const stat = await fsp.stat(book.fullPath);
    if (stat.size > MAX_TEXT_BYTES) throw new AppError('TEXT_TOO_LARGE', 'TXT 文件超过 64 MB，首版不直接载入。');
    const bytes = await fsp.readFile(book.fullPath);
    let encoding;
    if (requestedEncoding) {
      encoding = MANUAL_ENCODINGS[String(requestedEncoding).toLocaleLowerCase('en-US')];
      if (!encoding) throw new AppError('UNSUPPORTED_ENCODING', '不支持所选文本编码。');
    } else {
      encoding = normalizeDetectedEncoding(chardet.detect(bytes));
    }
    return {
      text: iconv.decode(bytes, encoding).replace(/^\uFEFF/, ''),
      encoding
    };
  }

  async loadBinary(bookId, expectedType, { signal = null } = {}) {
    const book = this.library.getBook(bookId);
    if (book.type !== expectedType) throw new AppError('WRONG_BOOK_TYPE', '文件类型与阅读器不匹配。');
    if (expectedType !== 'epub') {
      throw new AppError('BINARY_READER_UNSUPPORTED', '该文件必须使用专用读取方式。');
    }
    const stat = await fsp.stat(book.fullPath);
    if (stat.size > MAX_BINARY_BYTES) throw new AppError('FILE_TOO_LARGE', '文件超过 512 MB，首版不直接载入。');
    return readStreamBytes(book.fullPath, {
      maxBytes: MAX_BINARY_BYTES,
      signal,
      cancelledCode: 'EPUB_READ_CANCELLED',
      cancelledMessage: 'EPUB 读取已停止。'
    });
  }

  async openPdf(bookId, sessionId) {
    if (!validRequestId(sessionId)) throw new AppError('INVALID_READER_REQUEST', 'PDF 读取请求无效。');
    const book = this.library.getBook(bookId);
    if (book.type !== 'pdf') throw new AppError('WRONG_BOOK_TYPE', '该文件不是 PDF 文档。');
    await this.closePdf(sessionId);
    const stat = await fsp.stat(book.fullPath);
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0) {
      throw new AppError('PDF_INVALID', 'PDF 文件大小无效。');
    }
    this.pdfSessions.set(sessionId, {
      sessionId,
      bookId,
      fullPath: book.fullPath,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      controller: new AbortController(),
      pending: new Map(),
      cache: new Map(),
      cacheBytes: 0,
      closed: false
    });
    return {
      sessionId,
      length: stat.size,
      modifiedAt: stat.mtimeMs,
      rangeChunkSize: PDF_RANGE_CHUNK_BYTES
    };
  }

  async readPdfRange(bookId, options = {}) {
    const { sessionId, begin, end } = options;
    if (!validRequestId(sessionId)) throw new AppError('INVALID_READER_REQUEST', 'PDF 读取请求无效。');
    const session = this.pdfSessions.get(sessionId);
    if (!session || session.closed) throw readerCancelled('PDF_READ_CANCELLED', 'PDF 读取已停止。');
    if (session.bookId !== bookId) throw new AppError('INVALID_READER_REQUEST', 'PDF 读取会话与文件不匹配。');
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > session.size) {
      throw new AppError('PDF_RANGE_INVALID', 'PDF 读取范围无效。');
    }
    if (end - begin > PDF_MAX_RANGE_BYTES) {
      throw new AppError('PDF_RANGE_TOO_LARGE', 'PDF 单次读取范围过大。');
    }
    const stat = await fsp.stat(session.fullPath);
    if (stat.size !== session.size || stat.mtimeMs !== session.modifiedAt) {
      await this.closePdf(sessionId);
      throw new AppError('PDF_FILE_CHANGED', 'PDF 文件在读取期间发生变化。');
    }
    const key = `${begin}:${end}`;
    const cached = session.cache.get(key);
    if (cached) {
      cached.last = Date.now();
      return new Uint8Array(cached.bytes);
    }
    const existing = session.pending.get(key);
    if (existing) return new Uint8Array(await existing);

    let promise;
    promise = readStreamBytes(session.fullPath, {
      start: begin,
      end,
      maxBytes: PDF_MAX_RANGE_BYTES,
      signal: session.controller.signal,
      timeoutMs: PDF_RANGE_TIMEOUT_MS,
      cancelledCode: 'PDF_READ_CANCELLED',
      cancelledMessage: 'PDF 读取已停止。',
      timeoutCode: 'PDF_READ_TIMEOUT',
      timeoutMessage: 'PDF 读取超时，已停止。'
    }).then((bytes) => {
      if (session.closed || session.controller.signal.aborted || this.pdfSessions.get(sessionId) !== session) {
        throw readerCancelled('PDF_READ_CANCELLED', 'PDF 读取已停止。');
      }
      session.cache.set(key, { bytes, last: Date.now() });
      session.cacheBytes += bytes.length;
      this.evictPdfRanges(session);
      return bytes;
    }).finally(() => {
      if (session.pending.get(key) === promise) session.pending.delete(key);
    });
    session.pending.set(key, promise);
    return new Uint8Array(await promise);
  }

  evictPdfRanges(session) {
    if (session.cacheBytes <= PDF_RANGE_CACHE_LIMIT_BYTES) return;
    const candidates = [...session.cache.entries()].sort((a, b) => a[1].last - b[1].last);
    while (session.cacheBytes > PDF_RANGE_CACHE_LIMIT_BYTES && candidates.length) {
      const [key, entry] = candidates.shift();
      if (!session.cache.delete(key)) continue;
      session.cacheBytes -= entry.bytes.length;
    }
  }

  async closePdf(sessionId) {
    const session = this.pdfSessions.get(sessionId);
    if (!session) return false;
    session.closed = true;
    if (this.pdfSessions.get(sessionId) === session) this.pdfSessions.delete(sessionId);
    session.controller.abort();
    await Promise.allSettled([...session.pending.values()]);
    session.pending.clear();
    session.cache.clear();
    session.cacheBytes = 0;
    return true;
  }

  async closeAllPdfs() {
    await Promise.allSettled([...this.pdfSessions.keys()].map((sessionId) => this.closePdf(sessionId)));
  }

  async listArchive(bookId, options = {}) {
    const book = this.library.getBook(bookId);
    if (book.type !== 'comic') throw new AppError('WRONG_BOOK_TYPE', '该文件不是漫画压缩包。');
    const task = this.archive.trackRead(options.signal);
    try {
      return await this.archive.listPages(book.fullPath, { ...options, signal: task.signal });
    } finally {
      task.dispose();
    }
  }

  async openArchiveSession(bookId, sessionId, pages) {
    const book = this.library.getBook(bookId);
    if (book.type !== 'comic') throw new AppError('WRONG_BOOK_TYPE', '该文件不是漫画压缩包。');
    return this.archive.openSession(sessionId, book.fullPath, pages);
  }

  async closeArchiveSession(sessionId) {
    return this.archive.closeSession(sessionId);
  }

  async readArchivePage(bookId, entryName, onProgress = () => {}, options = {}) {
    const book = this.library.getBook(bookId);
    if (book.type !== 'comic') throw new AppError('WRONG_BOOK_TYPE', '该文件不是漫画压缩包。');
    return this.archive.readPage(book.fullPath, entryName, onProgress, options);
  }

  async clearCaches() {
    this.archive.abortAll();
    await this.archive.waitForIdle();
    if (typeof this.archive.closeAllSessions === 'function') await this.archive.closeAllSessions();
    this.archive.clear();
    await this.closeAllPdfs();
  }

  async shutdown() {
    this.archive.abortAll();
    await Promise.allSettled([
      this.archive.shutdown(),
      this.closeAllPdfs()
    ]);
  }
}

module.exports = {
  ReaderService,
  normalizeDetectedEncoding,
  MANUAL_ENCODINGS,
  MAX_BINARY_BYTES,
  PDF_RANGE_CHUNK_BYTES,
  PDF_MAX_RANGE_BYTES,
  PDF_RANGE_CACHE_LIMIT_BYTES,
  PDF_RANGE_TIMEOUT_MS,
  readStreamBytes
};
