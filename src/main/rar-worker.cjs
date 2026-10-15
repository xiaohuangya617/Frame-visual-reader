const { parentPort, workerData } = require('node:worker_threads');
const { createExtractorFromFile, UnrarError } = require('node-unrar-js');

function errorPayload(error) {
  if (error?.code === 'ENCRYPTED_CONTENT' || error instanceof UnrarError && /PASSWORD/i.test(String(error.reason))) {
    return { code: 'ENCRYPTED_CONTENT', message: 'RAR 内容已加密。' };
  }
  return { code: 'ARCHIVE_INVALID', message: 'RAR 压缩包损坏或格式不受支持。' };
}

async function run() {
  const extractor = await createExtractorFromFile({
    filepath: workerData.archivePath,
    targetPath: workerData.targetPath,
    filenameTransform: workerData.tempName
      ? (name) => name === workerData.pageName ? workerData.tempName : name
      : undefined
  });

  if (workerData.action === 'list') {
    const list = extractor.getFileList();
    if (list.arcHeader.flags.headerEncrypted) {
      throw Object.assign(new Error('RAR 内容已加密。'), { code: 'ENCRYPTED_CONTENT' });
    }
    const pages = [...list.fileHeaders].map((header) => ({
      name: header.name,
      size: Number(header.unpSize || 0),
      directory: header.flags.directory === true,
      encrypted: header.flags.encrypted === true
    }));
    if (pages.some((page) => page.encrypted)) {
      throw Object.assign(new Error('RAR 内容已加密。'), { code: 'ENCRYPTED_CONTENT' });
    }
    return { pages };
  }

  const extracted = extractor.extract({ files: [workerData.pageName] });
  const files = [...extracted.files];
  return {
    files: files.map((file) => ({
      name: file.fileHeader.name,
      encrypted: file.fileHeader.flags.encrypted === true
    }))
  };
}

run()
  .then((data) => parentPort.postMessage({ ok: true, data }))
  .catch((error) => parentPort.postMessage({ ok: false, error: errorPayload(error) }))
  .finally(() => parentPort.close());
