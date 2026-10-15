const path = require('node:path');

const FORMAT_BY_EXTENSION = Object.freeze({
  '.zip': 'comic',
  '.cbz': 'comic',
  '.rar': 'comic',
  '.cbr': 'comic',
  '.7z': 'comic',
  '.cb7': 'comic',
  '.txt': 'text',
  '.epub': 'epub',
  '.pdf': 'pdf'
});

const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
});

function normalizePathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function isPathWithinRoot(filePath, rootPath) {
  const relative = path.relative(normalizePathKey(rootPath), normalizePathKey(filePath));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function extensionOf(value) {
  return path.extname(value).toLocaleLowerCase('en-US');
}

module.exports = {
  FORMAT_BY_EXTENSION,
  IMAGE_MIME_BY_EXTENSION,
  normalizePathKey,
  isPathWithinRoot,
  extensionOf
};
