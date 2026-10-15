const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_PDFJS_VERSION = '6.3.289';
const PATCH_MARKER = '// random-reader-pdfjs-sparse-cache-v2';
const LEGACY_PATCH_MARKER = 'class SparseChunkedBytes {';
const PDF_WORKER_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;

const sparseBytesSource = `${PATCH_MARKER}
class SparseChunkedBytes {
  #chunks = new Map();
  #residentBytes = 0;
  #onEvict = null;
  constructor(length, chunkSize, onEvict) {
    this.length = this.byteLength = length;
    this.chunkSize = chunkSize;
    this.#onEvict = onEvict;
  }
  #touch(index, chunk) {
    this.#chunks.delete(index);
    this.#chunks.set(index, chunk);
  }
  #evict(protectedChunks) {
    while (this.#residentBytes > ${PDF_WORKER_CACHE_LIMIT_BYTES}) {
      const candidate = this.#chunks.entries().find(([index]) => !protectedChunks.has(index));
      if (!candidate) {
        break;
      }
      const [index, chunk] = candidate;
      this.#chunks.delete(index);
      this.#residentBytes -= chunk.byteLength;
      this.#onEvict(index);
    }
  }
  set(source, begin) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const protectedChunks = new Set();
    let sourceOffset = 0;
    while (sourceOffset < bytes.byteLength) {
      const position = begin + sourceOffset;
      const index = Math.floor(position / this.chunkSize);
      const offset = position % this.chunkSize;
      const chunkLength = Math.min(this.chunkSize, this.length - index * this.chunkSize);
      let chunk = this.#chunks.get(index);
      if (!chunk) {
        chunk = new Uint8Array(chunkLength);
        this.#residentBytes += chunk.byteLength;
      }
      const copyLength = Math.min(bytes.byteLength - sourceOffset, chunk.byteLength - offset);
      chunk.set(bytes.subarray(sourceOffset, sourceOffset + copyLength), offset);
      this.#touch(index, chunk);
      protectedChunks.add(index);
      sourceOffset += copyLength;
    }
    this.#evict(protectedChunks);
  }
  get(position) {
    const index = Math.floor(position / this.chunkSize);
    const chunk = this.#chunks.get(index);
    if (!chunk) {
      return 0;
    }
    this.#touch(index, chunk);
    return chunk[position % this.chunkSize];
  }
  subarray(begin, end) {
    const length = Math.max(0, end - begin);
    if (length === 0) {
      return new Uint8Array(0);
    }
    const firstIndex = Math.floor(begin / this.chunkSize);
    const lastIndex = Math.floor((end - 1) / this.chunkSize);
    if (firstIndex === lastIndex) {
      const chunk = this.#chunks.get(firstIndex);
      if (!chunk) {
        return new Uint8Array(length);
      }
      this.#touch(firstIndex, chunk);
      const offset = begin % this.chunkSize;
      return chunk.subarray(offset, offset + length);
    }
    const result = new Uint8Array(length);
    let targetOffset = 0;
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const chunk = this.#chunks.get(index);
      const chunkStart = index * this.chunkSize;
      const copyStart = Math.max(begin, chunkStart);
      const copyEnd = Math.min(end, chunkStart + this.chunkSize);
      if (chunk) {
        result.set(chunk.subarray(copyStart - chunkStart, copyEnd - chunkStart), targetOffset);
        this.#touch(index, chunk);
      }
      targetOffset += copyEnd - copyStart;
    }
    return result;
  }
}
`;

function replaceExactly(source, before, after, description) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`PDF.js Worker 补丁定位失败：${description}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const legacyEvictionCallback =
  'this.bytes = new SparseChunkedBytes(length, chunkSize, index => this._loadedChunks.delete(index));';
const evictionCallback = `this.bytes = new SparseChunkedBytes(length, chunkSize, index => {
      this._loadedChunks.delete(index);
      if (this._lastSuccessfulEnsureByteChunk === index) {
        this._lastSuccessfulEnsureByteChunk = -1;
      }
    });`;

function validatePatchedWorker(source) {
  if (
    !source.includes(PATCH_MARKER)
    || source.includes('super(new Uint8Array(length), 0, length, null);')
    || !source.includes('this._lastSuccessfulEnsureByteChunk = -1;')
  ) {
    throw new Error('PDF.js Worker 补丁结果校验失败。');
  }
  return source;
}

function patchWorkerSource(source) {
  if (source.includes(PATCH_MARKER)) return validatePatchedWorker(source);

  if (source.includes(LEGACY_PATCH_MARKER)) {
    source = replaceExactly(
      source,
      LEGACY_PATCH_MARKER,
      `${PATCH_MARKER}\n${LEGACY_PATCH_MARKER}`,
      '升级补丁版本标记'
    );
    source = replaceExactly(
      source,
      legacyEvictionCallback,
      evictionCallback,
      '升级缓存淘汰回调'
    );
    return validatePatchedWorker(source);
  }

  source = replaceExactly(
    source,
    'class ChunkedStream extends Stream {',
    `${sparseBytesSource}\nclass ChunkedStream extends Stream {`,
    '插入稀疏分块存储'
  );
  source = replaceExactly(
    source,
    `  constructor(length, chunkSize, manager) {
    super(new Uint8Array(length), 0, length, null);
    this.chunkSize = chunkSize;
    this.numChunks = Math.ceil(length / chunkSize);
    this.manager = manager;
  }`,
    `  constructor(length, chunkSize, manager) {
    super(new Uint8Array(0), 0, 0, null);
    this.start = this.pos = 0;
    this.end = length;
    this.chunkSize = chunkSize;
    this.numChunks = Math.ceil(length / chunkSize);
    this.manager = manager;
    ${evictionCallback}
  }`,
    '替换完整长度数组'
  );
  source = replaceExactly(
    source,
    `    return this.bytes[this.pos++];
  }
  getBytes(length) {
    const pos = this.pos;`,
    `    return this.bytes.get(this.pos++);
  }
  getBytes(length) {
    const pos = this.pos;`,
    '替换稀疏单字节读取'
  );
  source = replaceExactly(
    source,
    `  requestAllChunks(noFetch = false) {
    if (!noFetch) {
      const missingChunks = this.stream.getMissingChunks();`,
    `  requestAllChunks(noFetch = false) {
    if (!noFetch && this.length > ${PDF_WORKER_CACHE_LIMIT_BYTES}) {
      return Promise.reject(new InvalidPDFException("超大 PDF 不支持整本回退读取。"));
    }
    if (!noFetch) {
      const missingChunks = this.stream.getMissingChunks();`,
    '阻止超大文件整本回退'
  );
  source = replaceExactly(
    source,
    'const uint8array = stream.buffer ? new Uint8Array(stream.buffer.buffer, 0, stream.bufferLength) : new Uint8Array(stream.bytes.buffer, stream.start, stream.end - stream.start);',
    'const uint8array = stream.buffer ? new Uint8Array(stream.buffer.buffer, 0, stream.bufferLength) : stream.getByteRange(stream.start, stream.end);',
    '移除子流连续缓冲依赖'
  );
  source = source.replaceAll('return stream.bytes;', 'return stream.getByteRange(0, stream.end);');
  source = replaceExactly(
    source,
    'originalData: stream.bytes,',
    'originalData: stream.getByteRange(0, stream.end),',
    '按需导出完整数据'
  );

  return validatePatchedWorker(source);
}

function patchInstalledWorker(projectRoot = path.resolve(__dirname, '..')) {
  const packagePath = path.join(projectRoot, 'node_modules', 'pdfjs-dist', 'package.json');
  const workerPath = path.join(projectRoot, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== EXPECTED_PDFJS_VERSION) {
    throw new Error(`PDF.js 版本不匹配：需要 ${EXPECTED_PDFJS_VERSION}，实际 ${packageJson.version}`);
  }
  const source = fs.readFileSync(workerPath, 'utf8');
  const patched = patchWorkerSource(source);
  if (patched !== source) fs.writeFileSync(workerPath, patched, 'utf8');
  console.log(`PDF.js Worker 稀疏分块补丁已就绪：${packageJson.version}`);
  return workerPath;
}

if (require.main === module) patchInstalledWorker();

module.exports = {
  EXPECTED_PDFJS_VERSION,
  PATCH_MARKER,
  LEGACY_PATCH_MARKER,
  PDF_WORKER_CACHE_LIMIT_BYTES,
  patchWorkerSource,
  patchInstalledWorker
};
