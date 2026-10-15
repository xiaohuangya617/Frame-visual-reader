const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { path7za } = require('7zip-bin');
const { UnrarError } = require('node-unrar-js');
const { AppError } = require('./app-error.cjs');
const { IMAGE_MIME_BY_EXTENSION, normalizePathKey, extensionOf } = require('./constants.cjs');

const MAX_PAGE_BYTES = 100 * 1024 * 1024;
const MAX_LIST_BYTES = 20 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const RAR_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;
const SESSION_CACHE_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
const ARCHIVE_READ_TIMEOUT_MS = 30_000;
const ARCHIVE_PROCESS_KILL_GRACE_MS = 1_000;
const RAR_WORKER_PATH = path.join(__dirname, 'rar-worker.cjs').replace('app.asar', 'app.asar.unpacked');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function rarCacheIdentity(archivePath, stat) {
  const normalizedPath = normalizePathKey(archivePath);
  return {
    archiveKey: hash(normalizedPath),
    versionKey: hash(`${normalizedPath}\0${stat.size}\0${stat.mtimeMs}`)
  };
}

function executablePath() {
  return path7za.replace('app.asar', 'app.asar.unpacked');
}

function delayArchiveReadForTest(signal = null) {
  const delayMs = Number(process.env.RANDOM_READER_E2E_DELAY_ARCHIVE_MS);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return Promise.resolve();
  const cancelled = () => new AppError('ARCHIVE_READ_CANCELLED', '压缩包读取已取消。');
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, Math.min(delayMs, 5000));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(cancelled());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function looksEncrypted(value) {
  return /encrypted|wrong password|password is incorrect|can not open encrypted/i.test(value);
}

function run7z(args, maxBytes = MAX_LIST_BYTES, onChunk = null, {
  signal = null,
  timeoutMs = ARCHIVE_READ_TIMEOUT_MS,
  spawnImpl = spawn,
  executable = executablePath()
} = {}) {
  return new Promise((resolve, reject) => {
    const cancelled = () => new AppError('ARCHIVE_READ_CANCELLED', '压缩包读取已取消。');
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    let child;
    try {
      child = spawnImpl(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      reject(new AppError('ARCHIVE_ENGINE_FAILED', '压缩包读取组件无法启动。'));
      return;
    }
    const stdout = [];
    const stderr = [];
    let size = 0;
    let stderrSize = 0;
    let settled = false;
    let terminating = false;
    let terminationError = null;
    let timeoutHandle = null;
    let killGraceHandle = null;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clearTimeout(killGraceHandle);
      signal?.removeEventListener('abort', abort);
    };
    const settle = (error = null, value = undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (error) => {
      if (settled || terminating) return;
      terminating = true;
      terminationError = error;
      clearTimeout(timeoutHandle);
      try {
        const killed = child.kill();
        if (killed === false && child.exitCode !== null) settle(error);
      } catch {
        settle(error);
        return;
      }
      killGraceHandle = setTimeout(() => settle(error), ARCHIVE_PROCESS_KILL_GRACE_MS);
    };
    const abort = () => fail(cancelled());

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new AppError('ARCHIVE_ENTRY_TOO_LARGE', '压缩包页面过大，已停止读取。'));
        return;
      }
      stdout.push(chunk);
      if (onChunk) onChunk(size);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > MAX_STDERR_BYTES) {
        fail(new AppError('ARCHIVE_ERROR_OUTPUT_TOO_LARGE', '压缩包错误输出过大，已停止读取。'));
        return;
      }
      stderr.push(chunk);
    });
    child.on('error', () => fail(new AppError('ARCHIVE_ENGINE_FAILED', '压缩包读取组件无法启动。')));
    child.on('close', (code) => {
      if (settled) return;
      if (terminating) {
        settle(terminationError);
        return;
      }
      const output = Buffer.concat(stdout);
      const errorText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        const combined = `${errorText}\n${output.toString('utf8')}`;
        if (looksEncrypted(combined)) {
          settle(new AppError('ENCRYPTED_CONTENT', '该压缩包已加密，首版不支持读取。'));
        } else {
          settle(new AppError('ARCHIVE_INVALID', '压缩包损坏或格式不受支持。'));
        }
        return;
      }
      settle(null, { output, errorText });
    });
    signal?.addEventListener('abort', abort, { once: true });
    timeoutHandle = setTimeout(() => {
      fail(new AppError('ARCHIVE_READ_TIMEOUT', '压缩包读取超时，已停止。'));
    }, Math.max(1, Number(timeoutMs) || ARCHIVE_READ_TIMEOUT_MS));
    if (signal?.aborted) abort();
  });
}

function parseTechnicalList(text) {
  const records = [];
  let current = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.Path) records.push(current);
      current = {};
      continue;
    }
    const separator = line.indexOf(' = ');
    if (separator === -1) continue;
    current[line.slice(0, separator)] = line.slice(separator + 3);
  }
  if (current.Path) records.push(current);
  return records;
}

function mapRarError(error) {
  if (error instanceof UnrarError && /PASSWORD/i.test(String(error.reason))) {
    return new AppError('ENCRYPTED_CONTENT', '该 RAR 压缩包已加密，首版不支持读取。');
  }
  return new AppError('ARCHIVE_INVALID', 'RAR 压缩包损坏或格式不受支持。');
}

function runRarWorker(workerData, {
  signal = null,
  timeoutMs = ARCHIVE_READ_TIMEOUT_MS,
  workerImpl = Worker
} = {}) {
  return new Promise((resolve, reject) => {
    const cancelled = () => new AppError('ARCHIVE_READ_CANCELLED', '压缩包读取已取消。');
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    let worker;
    try {
      worker = new workerImpl(RAR_WORKER_PATH, { workerData });
    } catch (error) {
      reject(new AppError('ARCHIVE_ENGINE_FAILED', 'RAR 读取组件无法启动。', { cause: error?.message }));
      return;
    }
    let settled = false;
    let timeoutHandle = null;
    let terminationPromise = null;
    let resolveWorkerExit;
    const workerExit = new Promise((resolve) => { resolveWorkerExit = resolve; });
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (error = null, value = undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      if (settled) return Promise.resolve();
      if (terminationPromise) return terminationPromise;
      const termination = Promise.race([
        Promise.resolve().then(() => worker.terminate()),
        workerExit
      ]).catch(() => workerExit);
      terminationPromise = termination
        .then(() => settle(error));
      return terminationPromise;
    };
    const onAbort = () => { void terminate(cancelled()); };

    worker.once('message', (message) => {
      if (settled || terminationPromise) return;
      if (message?.ok) {
        settle(null, message.data);
      } else {
        const code = message?.error?.code;
        if (code === 'ENCRYPTED_CONTENT') settle(new AppError(code, '该 RAR 压缩包已加密，首版不支持读取。'));
        else settle(new AppError('ARCHIVE_INVALID', 'RAR 压缩包损坏或格式不受支持。'));
      }
    });
    worker.once('error', (error) => {
      if (settled || terminationPromise) return;
      settle(new AppError('ARCHIVE_ENGINE_FAILED', 'RAR 读取组件运行失败。', { cause: error?.message }));
    });
    worker.once('exit', (code) => {
      resolveWorkerExit(code);
      if (terminationPromise) return;
      if (!settled) settle(new AppError('ARCHIVE_ENGINE_FAILED', code === 0 ? 'RAR 读取组件未返回结果。' : 'RAR 读取组件异常退出。'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    timeoutHandle = setTimeout(() => {
      void terminate(new AppError('ARCHIVE_READ_TIMEOUT', 'RAR 压缩包读取超时，已停止。'));
    }, Math.max(1, Number(timeoutMs) || ARCHIVE_READ_TIMEOUT_MS));
    if (signal?.aborted) onAbort();
  });
}

class ArchiveService {
  constructor(dataDir, {
    cacheLimitBytes = RAR_CACHE_LIMIT_BYTES,
    sessionCacheRoot = path.join(os.tmpdir(), 'ApeiriaReader', 'comic-sessions'),
    sessionReserveBytes = SESSION_CACHE_RESERVE_BYTES,
    statfsImpl = (target) => fs.statfs(target)
  } = {}) {
    this.dataDir = dataDir;
    this.rarCacheRoot = path.join(dataDir, 'cache', 'rar');
    this.sessionCacheRoot = sessionCacheRoot;
    this.sessionInstanceRoot = path.join(sessionCacheRoot, `${process.pid}-${crypto.randomUUID()}`);
    this.cacheLimitBytes = cacheLimitBytes;
    this.sessionReserveBytes = Math.max(0, Number(sessionReserveBytes) || 0);
    this.statfsImpl = statfsImpl;
    this.indexCache = new Map();
    this.archiveSessions = new Map();
    this.pageTasks = new Map();
    this.activeCachePaths = new Set();
    this.activeReadTasks = new Map();
    this.maintenanceChain = Promise.resolve();
    this.cleanupWriteChain = Promise.resolve();
    this.cleanupPendingPath = path.join(dataDir, 'cache', 'cleanup-pending.json');
    this.ready = Promise.all([
      this.cleanupCacheOnStartup(),
      this.initializeSessionCache()
    ]).catch(() => {});
  }

  async initialize() {
    await this.ready;
  }

  async openSession(sessionId, archivePath, pages) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw new AppError('INVALID_READER_REQUEST', '漫画读取会话无效。');
    }
    await this.ready;
    await this.closeSession(sessionId);
    const stat = await fs.stat(archivePath);
    const cacheDir = path.join(this.sessionInstanceRoot, hash(sessionId));
    await fs.mkdir(cacheDir, { recursive: true });
    const normalizedPages = Array.isArray(pages) ? pages : [];
    const plannedBytes = normalizedPages.reduce((total, page) => {
      const size = Number(page?.size);
      return total + (Number.isSafeInteger(size) && size > 0 && size <= MAX_PAGE_BYTES ? size : 0);
    }, 0);
    const freeBytes = await this.sessionFreeBytes(cacheDir);
    const backgroundPrefetch = freeBytes === null
      || plannedBytes <= Math.max(0, freeBytes - this.sessionReserveBytes);
    const session = {
      sessionId,
      archivePath,
      archivePathKey: normalizePathKey(archivePath),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      cacheDir,
      pages: new Map(normalizedPages.map((page) => [page.name, page])),
      plannedBytes,
      cacheBytes: 0,
      cachedPages: new Map(),
      backgroundPrefetch,
      cacheStatus: backgroundPrefetch ? 'ready' : 'space-low',
      writeChain: Promise.resolve(),
      reads: new Set(),
      aborters: new Set(),
      closed: false
    };
    this.archiveSessions.set(sessionId, session);
    return {
      sessionId,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      plannedBytes,
      backgroundPrefetch,
      cacheStatus: session.cacheStatus
    };
  }

  async initializeSessionCache() {
    await fs.mkdir(this.sessionCacheRoot, { recursive: true });
    await this.cleanupStaleSessionCaches();
    await fs.mkdir(this.sessionInstanceRoot, { recursive: true });
  }

  async cleanupStaleSessionCaches() {
    let entries;
    try {
      entries = await fs.readdir(this.sessionCacheRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^(\d+)-[0-9a-f-]{16,}$/i.exec(entry.name);
      if (!match || processIsRunning(Number(match[1]))) continue;
      const target = path.join(this.sessionCacheRoot, entry.name);
      if (!this.isManagedSessionPath(target)) continue;
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  }

  isManagedSessionPath(targetPath) {
    const relative = path.relative(path.resolve(this.sessionCacheRoot), path.resolve(targetPath));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  async sessionFreeBytes(targetPath) {
    try {
      const stat = await this.statfsImpl(targetPath);
      const blocks = Number(stat?.bavail ?? stat?.bfree);
      const blockSize = Number(stat?.bsize ?? stat?.frsize);
      const freeBytes = blocks * blockSize;
      return Number.isFinite(freeBytes) && freeBytes >= 0 ? freeBytes : null;
    } catch {
      return null;
    }
  }

  async validateSession(sessionId, archivePath) {
    if (!sessionId) return null;
    const session = this.archiveSessions.get(sessionId);
    if (!session || session.closed || session.archivePathKey !== normalizePathKey(archivePath)) {
      throw new AppError('ARCHIVE_READ_CANCELLED', '漫画读取会话已结束。');
    }
    const stat = await fs.stat(archivePath);
    if (stat.size !== session.size || stat.mtimeMs !== session.modifiedAt) {
      this.invalidateSession(session);
      throw new AppError('ARCHIVE_FILE_CHANGED', '漫画文件在阅读期间发生变化，请重新打开。');
    }
    return session;
  }

  invalidateSession(session) {
    if (!session || session.closed) return;
    session.closed = true;
    if (this.archiveSessions.get(session.sessionId) === session) this.archiveSessions.delete(session.sessionId);
    for (const abort of session.aborters) abort();
    void this.removeSessionCacheWhenIdle(session);
  }

  sessionPagePath(session, entryName) {
    const extension = extensionOf(entryName);
    return path.join(session.cacheDir, `${hash(entryName)}${extension}`);
  }

  async readSessionPage(session, page) {
    const cachePath = this.sessionPagePath(session, page.name);
    try {
      const bytes = await fs.readFile(cachePath);
      if (bytes.length > MAX_PAGE_BYTES) {
        await fs.rm(cachePath, { force: true });
        const previousSize = session.cachedPages.get(page.name) || 0;
        session.cachedPages.delete(page.name);
        session.cacheBytes = Math.max(0, session.cacheBytes - previousSize);
        return null;
      }
      if (!session.cachedPages.has(page.name)) {
        session.cachedPages.set(page.name, bytes.length);
        session.cacheBytes += bytes.length;
      }
      return { bytes: new Uint8Array(bytes), mime: page.mime, sessionCached: true };
    } catch (error) {
      if (error.code === 'ENOENT') {
        const previousSize = session.cachedPages.get(page.name) || 0;
        session.cachedPages.delete(page.name);
        session.cacheBytes = Math.max(0, session.cacheBytes - previousSize);
        return null;
      }
      throw error;
    }
  }

  async writeSessionPage(session, page, bytes) {
    const write = session.writeChain.catch(() => false).then(() => this.writeSessionPageNow(session, page, bytes));
    session.writeChain = write;
    return write;
  }

  async writeSessionPageNow(session, page, bytes) {
    if (session.closed || this.archiveSessions.get(session.sessionId) !== session) return false;
    const cachePath = this.sessionPagePath(session, page.name);
    const tempPath = `${cachePath}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      const freeBytes = await this.sessionFreeBytes(session.cacheDir);
      if (freeBytes !== null && freeBytes - bytes.length < this.sessionReserveBytes) {
        session.backgroundPrefetch = false;
        session.cacheStatus = 'space-low';
        return false;
      }
      await fs.writeFile(tempPath, bytes);
      if (session.closed || this.archiveSessions.get(session.sessionId) !== session) return false;
      await fs.rename(tempPath, cachePath);
      const previousSize = session.cachedPages.get(page.name) || 0;
      session.cachedPages.set(page.name, bytes.length);
      session.cacheBytes = Math.max(0, session.cacheBytes - previousSize + bytes.length);
      return true;
    } catch (error) {
      if (!['ENOSPC', 'EDQUOT', 'ENOENT'].includes(error.code)) throw error;
      session.backgroundPrefetch = false;
      session.cacheStatus = error.code === 'ENOENT' ? 'closed' : 'space-low';
      return false;
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async removeSessionCacheWhenIdle(session) {
    await Promise.allSettled([...session.reads]);
    await fs.rm(session.cacheDir, { recursive: true, force: true }).catch(() => {});
  }

  async closeSession(sessionId) {
    const session = this.archiveSessions.get(sessionId);
    if (!session) return false;
    session.closed = true;
    this.archiveSessions.delete(sessionId);
    for (const abort of session.aborters) abort();
    await this.removeSessionCacheWhenIdle(session);
    return true;
  }

  async closeAllSessions() {
    await Promise.allSettled([...this.archiveSessions.keys()].map((sessionId) => this.closeSession(sessionId)));
    await fs.rm(this.sessionInstanceRoot, { recursive: true, force: true }).catch(() => {});
  }

  async listPages(archivePath, { signal = null } = {}) {
    await this.ready;
    const stat = await fs.stat(archivePath);
    const archivePathKey = normalizePathKey(archivePath);
    const cached = this.indexCache.get(archivePathKey);
    if (cached && cached.size === stat.size && cached.modifiedAt === stat.mtimeMs) return cached.pages;

    if (['.rar', '.cbr'].includes(extensionOf(archivePath))) {
      await this.prepareRarCache(archivePath, stat);
      return this.listRarPages(archivePath, stat, signal);
    }

    const { output, errorText } = await run7z(
      ['l', '-slt', '-ba', '-sccUTF-8', archivePath],
      MAX_LIST_BYTES,
      null,
      { signal }
    );
    if (looksEncrypted(errorText)) throw new AppError('ENCRYPTED_CONTENT', '该压缩包已加密，首版不支持读取。');

    const records = parseTechnicalList(output.toString('utf8'));
    if (records.some((record) => record.Encrypted === '+')) {
      throw new AppError('ENCRYPTED_CONTENT', '该压缩包已加密，首版不支持读取。');
    }
    const pages = records
      .filter((record) => record.Folder !== '+' && IMAGE_MIME_BY_EXTENSION[extensionOf(record.Path)])
      .map((record) => ({
        name: record.Path,
        size: Number(record.Size || 0),
        mime: IMAGE_MIME_BY_EXTENSION[extensionOf(record.Path)]
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    if (pages.length === 0) throw new AppError('ARCHIVE_EMPTY', '压缩包中没有可读取的图片。');
    this.indexCache.set(archivePathKey, { size: stat.size, modifiedAt: stat.mtimeMs, pages });
    return pages;
  }

  async readPage(archivePath, entryName, onProgress = () => {}, {
    signal = null,
    sessionId = null,
    refresh = false,
    cacheOnly = false
  } = {}) {
    const task = this.trackRead(signal);
    let session = null;
    let sessionRead = null;
    let resolveSessionRead = null;
    try {
      if (sessionId) {
        session = await this.validateSession(sessionId, archivePath);
        if (session.closed || this.archiveSessions.get(sessionId) !== session) {
          throw new AppError('ARCHIVE_READ_CANCELLED', '漫画读取会话已结束。');
        }
        session.aborters.add(task.abort);
        sessionRead = new Promise((resolve) => { resolveSessionRead = resolve; });
        session.reads.add(sessionRead);
        const knownPage = session.pages.get(entryName);
        if (knownPage && !refresh) {
          const cached = await this.readSessionPage(session, knownPage);
          if (cached) return cacheOnly
            ? { bytes: new Uint8Array(0), mime: cached.mime, sessionCached: true, sessionCacheStatus: session.cacheStatus }
            : cached;
        }
        if (cacheOnly && !session.backgroundPrefetch) {
          return {
            bytes: new Uint8Array(0),
            mime: knownPage?.mime || 'application/octet-stream',
            sessionCached: false,
            sessionCacheStatus: session.cacheStatus
          };
        }
      }
      await delayArchiveReadForTest(task.signal);
      const pages = await this.listPages(archivePath, { signal: task.signal });
      const page = pages.find((item) => item.name === entryName);
      if (!page) throw new AppError('ARCHIVE_ENTRY_NOT_FOUND', '压缩包页面不存在。');
      if (session && !refresh) {
        const cached = await this.readSessionPage(session, page);
        if (cached) return cacheOnly
          ? { bytes: new Uint8Array(0), mime: cached.mime, sessionCached: true, sessionCacheStatus: session.cacheStatus }
          : cached;
      }
      if (page.size > MAX_PAGE_BYTES) throw new AppError('ARCHIVE_ENTRY_TOO_LARGE', '压缩包页面超过 100 MB，已停止读取。');
      const report = (phase, loadedBytes) => {
        try { onProgress({ phase, entryName, loadedBytes, totalBytes: page.size }); } catch {}
      };
      report('start', 0);
      try {
        let result;
        if (['.rar', '.cbr'].includes(extensionOf(archivePath))) {
          result = await this.readRarPage(archivePath, page, task.signal);
        } else {
          const { output } = await run7z(
            ['x', '-so', '-y', '-spd', archivePath, entryName],
            MAX_PAGE_BYTES,
            (loadedBytes) => report('progress', loadedBytes),
            { signal: task.signal }
          );
          result = { bytes: new Uint8Array(output), mime: page.mime };
        }
        report('complete', page.size || result.bytes.length);
        const sessionCached = session ? await this.writeSessionPage(session, page, result.bytes) : false;
        return cacheOnly
          ? {
              bytes: new Uint8Array(0),
              mime: result.mime,
              sessionCached,
              sessionCacheStatus: session?.cacheStatus || null
            }
          : { ...result, sessionCached, sessionCacheStatus: session?.cacheStatus || null };
      } catch (error) {
        report('error', 0);
        throw error;
      }
    } finally {
      if (session) {
        session.aborters.delete(task.abort);
        if (sessionRead) session.reads.delete(sessionRead);
        resolveSessionRead?.();
      }
      task.dispose();
    }
  }

  async listRarPages(archivePath, stat, signal = null) {
    try {
      const result = await runRarWorker({ action: 'list', archivePath }, { signal });
      const pages = result.pages
        .filter((header) => !header.directory && IMAGE_MIME_BY_EXTENSION[extensionOf(header.name)])
        .map((header) => ({ name: header.name, size: header.size, mime: IMAGE_MIME_BY_EXTENSION[extensionOf(header.name)] }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      if (pages.length === 0) throw new AppError('ARCHIVE_EMPTY', 'RAR 压缩包中没有可读取的图片。');
      this.indexCache.set(normalizePathKey(archivePath), { size: stat.size, modifiedAt: stat.mtimeMs, pages });
      return pages;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRarError(error);
    }
  }

  async readRarPage(archivePath, page, signal = null) {
    if (signal?.aborted) throw new AppError('ARCHIVE_READ_CANCELLED', '压缩包读取已取消。');
    await this.ready;
    const stat = await fs.stat(archivePath);
    const { archiveKey, versionKey } = await this.prepareRarCache(archivePath, stat);
    const entryKey = hash(page.name);
    const cacheDir = path.join(this.rarCacheRoot, archiveKey, versionKey);
    const cacheName = `${entryKey}${extensionOf(page.name)}`;
    const cachePath = path.join(cacheDir, cacheName);
    const existingTask = this.pageTasks.get(cachePath);
    const sharedTask = existingTask || this.createRarPageTask(archivePath, page, cacheDir, cacheName, cachePath);
    if (!existingTask) this.pageTasks.set(cachePath, sharedTask);
    return this.waitForRarPageTask(sharedTask, signal);
  }

  createRarPageTask(archivePath, page, cacheDir, cacheName, cachePath) {
    const sharedTask = {
      controller: new AbortController(),
      subscribers: 0,
      settled: false,
      promise: null
    };
    sharedTask.promise = this.readOrExtractRarPage(archivePath, page, cacheDir, cacheName, cachePath, sharedTask.controller.signal);
    sharedTask.promise.then(
      () => this.finishRarPageTask(cachePath, sharedTask),
      () => this.finishRarPageTask(cachePath, sharedTask)
    );
    return sharedTask;
  }

  finishRarPageTask(cachePath, sharedTask) {
    sharedTask.settled = true;
    if (this.pageTasks.get(cachePath) === sharedTask) this.pageTasks.delete(cachePath);
  }

  waitForRarPageTask(sharedTask, signal = null) {
    const cancelled = () => new AppError('ARCHIVE_READ_CANCELLED', '压缩包读取已取消。');
    if (signal?.aborted) return Promise.reject(cancelled());
    sharedTask.subscribers += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', onAbort);
        sharedTask.subscribers -= 1;
        if (sharedTask.subscribers === 0 && !sharedTask.settled) sharedTask.controller.abort();
      };
      const onAbort = () => {
        release();
        reject(cancelled());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      sharedTask.promise.then((value) => {
        release();
        if (signal?.aborted) reject(cancelled());
        else resolve(value);
      }, (error) => {
        release();
        reject(error);
      });
    });
  }

  async readOrExtractRarPage(archivePath, page, cacheDir, cacheName, cachePath, signal = null) {
    const cancelled = () => new AppError('ARCHIVE_READ_CANCELLED', '压缩包读取已取消。');
    if (signal?.aborted) throw cancelled();
    this.activeCachePaths.add(cachePath);
    try {
      try {
        const cachedStat = await fs.stat(cachePath);
        if (cachedStat.size <= MAX_PAGE_BYTES) {
          const cached = await fs.readFile(cachePath);
          if (signal?.aborted) throw cancelled();
          if (cached.length <= MAX_PAGE_BYTES) {
            const now = new Date();
            await fs.utimes(cachePath, now, now).catch(() => {});
            return { bytes: new Uint8Array(cached), mime: page.mime };
          }
        }
        await fs.rm(cachePath, { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      await fs.mkdir(cacheDir, { recursive: true });
      const tempName = `${cacheName}.${process.pid}-${crypto.randomUUID()}.tmp`;
      const tempPath = path.join(cacheDir, tempName);
      this.activeCachePaths.add(tempPath);
      try {
        const extracted = await runRarWorker({
          action: 'extract',
          archivePath,
          targetPath: cacheDir,
          pageName: page.name,
          tempName
        }, { signal });
        if (extracted.files.length === 0 || extracted.files[0].encrypted) {
          throw new AppError('ENCRYPTED_CONTENT', '该 RAR 页面已加密，首版不支持读取。');
        }
        if (signal?.aborted) throw cancelled();
        const extractedStat = await fs.stat(tempPath);
        if (extractedStat.size > MAX_PAGE_BYTES) {
          throw new AppError('ARCHIVE_ENTRY_TOO_LARGE', '压缩包页面超过 100 MB，已停止读取。');
        }
        await fs.rename(tempPath, cachePath);
        this.activeCachePaths.delete(tempPath);
        const bytes = await fs.readFile(cachePath);
        if (signal?.aborted) throw cancelled();
        await this.enforceCacheLimit(new Set([cachePath]));
        return { bytes: new Uint8Array(bytes), mime: page.mime };
      } catch (error) {
        try {
          await fs.rm(tempPath, { force: true });
        } catch (cleanupError) {
          await this.registerCleanup(tempPath, 'TEMP_FILE_REMOVE_FAILED', cleanupError);
        }
        if (error instanceof AppError) throw error;
        throw mapRarError(error);
      } finally {
        this.activeCachePaths.delete(tempPath);
      }
    } finally {
      this.activeCachePaths.delete(cachePath);
    }
  }

  queueMaintenance(operation) {
    const pending = this.maintenanceChain.catch(() => {}).then(operation);
    this.maintenanceChain = pending;
    return pending;
  }

  async prepareRarCache(archivePath, stat) {
    const identity = rarCacheIdentity(archivePath, stat);
    const archiveRoot = path.join(this.rarCacheRoot, identity.archiveKey);
    const currentRoot = path.join(archiveRoot, identity.versionKey);
    await this.queueMaintenance(async () => {
      await fs.mkdir(currentRoot, { recursive: true });
      let entries;
      try {
        entries = await fs.readdir(archiveRoot, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name === identity.versionKey) continue;
        const target = path.join(archiveRoot, entry.name);
        if (this.isCachePathActive(target)) continue;
        try {
          await fs.rm(target, { recursive: true, force: true });
        } catch (error) {
          await this.registerCleanup(target, 'STALE_CACHE_REMOVE_FAILED', error);
        }
      }
    });
    return identity;
  }

  isCachePathActive(target) {
    const targetKey = normalizePathKey(target);
    return [...this.activeCachePaths].some((activePath) => {
      const activeKey = normalizePathKey(activePath);
      return activeKey === targetKey || activeKey.startsWith(`${targetKey}${path.sep}`);
    });
  }

  async listCacheFiles(directory = this.rarCacheRoot) {
    const files = [];
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return files;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await this.listCacheFiles(fullPath));
      else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          files.push({ path: fullPath, size: stat.size, modifiedAt: stat.mtimeMs });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    return files;
  }

  enforceCacheLimit(extraProtected = new Set()) {
    return this.queueMaintenance(async () => {
      const files = await this.listCacheFiles();
      let total = files.reduce((sum, file) => sum + file.size, 0);
      if (total <= this.cacheLimitBytes) return total;
      const protectedKeys = new Set(
        [...this.activeCachePaths, ...extraProtected].map((filePath) => normalizePathKey(filePath))
      );
      files.sort((a, b) => a.modifiedAt - b.modifiedAt || a.path.localeCompare(b.path));
      for (const file of files) {
        if (total <= this.cacheLimitBytes) break;
        if (protectedKeys.has(normalizePathKey(file.path)) || file.path.endsWith('.tmp')) continue;
        try {
          await fs.rm(file.path, { force: true });
          total -= file.size;
        } catch (error) {
          await this.registerCleanup(file.path, 'CACHE_LIMIT_REMOVE_FAILED', error);
        }
      }
      return total;
    });
  }

  async cleanupCacheOnStartup() {
    await this.retryPendingCleanup();
    const files = await this.listCacheFiles();
    for (const file of files) {
      if (!file.path.endsWith('.tmp')) continue;
      try {
        await fs.rm(file.path, { force: true });
      } catch (error) {
        await this.registerCleanup(file.path, 'TEMP_FILE_REMOVE_FAILED', error);
      }
    }
    await this.enforceCacheLimit();
  }

  isManagedCachePath(targetPath) {
    const relative = path.relative(path.resolve(this.rarCacheRoot), path.resolve(targetPath));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  async readPendingCleanup() {
    try {
      const content = await fs.readFile(this.cleanupPendingPath, 'utf8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed)
        ? parsed.filter((item) => item && typeof item.path === 'string' && this.isManagedCachePath(item.path))
        : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      return [];
    }
  }

  async writePendingCleanup(entries) {
    if (entries.length === 0) {
      await fs.rm(this.cleanupPendingPath, { force: true }).catch(() => {});
      return;
    }
    await fs.mkdir(path.dirname(this.cleanupPendingPath), { recursive: true });
    const tempPath = `${this.cleanupPendingPath}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(entries, null, 2), 'utf8');
      await fs.rename(tempPath, this.cleanupPendingPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  registerCleanup(targetPath, reason, error = null) {
    if (!this.isManagedCachePath(targetPath)) return Promise.resolve(false);
    const resolvedPath = path.resolve(targetPath);
    const operation = this.cleanupWriteChain.catch(() => {}).then(async () => {
      const entries = await this.readPendingCleanup();
      const current = entries.find((item) => normalizePathKey(item.path) === normalizePathKey(resolvedPath));
      const now = new Date().toISOString();
      if (current) {
        current.reason = reason;
        current.lastAttemptAt = now;
        current.errorCode = error?.code || current.errorCode || null;
      } else {
        entries.push({
          path: resolvedPath,
          reason,
          firstSeenAt: now,
          lastAttemptAt: now,
          retryCount: 0,
          errorCode: error?.code || null
        });
      }
      await this.writePendingCleanup(entries);
      return true;
    });
    this.cleanupWriteChain = operation;
    return operation;
  }

  async retryPendingCleanup() {
    await this.cleanupWriteChain.catch(() => {});
    const entries = await this.readPendingCleanup();
    const remaining = [];
    for (const entry of entries) {
      try {
        await fs.rm(entry.path, { force: true, recursive: true });
      } catch (error) {
        remaining.push({
          ...entry,
          retryCount: (Number(entry.retryCount) || 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          errorCode: error?.code || entry.errorCode || null
        });
      }
    }
    await this.writePendingCleanup(remaining).catch(() => {});
  }

  clear(archivePath) {
    if (archivePath) this.indexCache.delete(normalizePathKey(archivePath));
    else this.indexCache.clear();
  }

  trackRead(externalSignal = null) {
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const relay = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', relay, { once: true });
    this.activeReadTasks.set(controller, done);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      dispose: () => {
        externalSignal?.removeEventListener('abort', relay);
        if (this.activeReadTasks.delete(controller)) resolveDone();
      }
    };
  }

  abortAll() {
    for (const controller of this.activeReadTasks.keys()) controller.abort();
    for (const task of this.pageTasks.values()) task.controller.abort();
  }

  async waitForIdle() {
    // 等待读取、共享页面任务和它们触发的维护操作全部结算，确保文件句柄和临时文件已释放。
    while (true) {
      const reads = [...this.activeReadTasks.values()];
      const pages = [...this.pageTasks.values()].map((task) => task.promise);
      const maintenance = this.maintenanceChain;
      const cleanup = this.cleanupWriteChain;
      if (reads.length || pages.length) {
        await Promise.allSettled([...reads, ...pages]);
        continue;
      }
      await Promise.allSettled([maintenance, cleanup]);
      if (reads.length === this.activeReadTasks.size
        && pages.length === this.pageTasks.size
        && maintenance === this.maintenanceChain
        && cleanup === this.cleanupWriteChain) break;
    }
  }

  async shutdown() {
    this.abortAll();
    await this.closeAllSessions();
    await this.waitForIdle();
    await this.retryPendingCleanup();
  }
}

module.exports = {
  ArchiveService,
  MAX_PAGE_BYTES,
  ARCHIVE_READ_TIMEOUT_MS,
  ARCHIVE_PROCESS_KILL_GRACE_MS,
  MAX_STDERR_BYTES,
  RAR_CACHE_LIMIT_BYTES,
  SESSION_CACHE_RESERVE_BYTES,
  processIsRunning,
  rarCacheIdentity,
  parseTechnicalList,
  looksEncrypted,
  executablePath,
  run7z,
  runRarWorker
};
