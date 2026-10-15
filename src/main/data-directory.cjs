const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIRECTORY_NAME = '图文阅读数据文件';
const LEGACY_DATA_DIRECTORY_NAME = '随机阅读数据文件';
const PORTABLE_DATA_DIRECTORY_NAME = 'data';

function resolveExecutableDirectory({ env = process.env, executablePath }) {
  return path.resolve(env.PORTABLE_EXECUTABLE_DIR || path.dirname(executablePath));
}

function resolveDataDirectory({ isPackaged, env = process.env, executablePath, projectRoot }) {
  if (env.RANDOM_READER_DATA_DIR) return path.resolve(env.RANDOM_READER_DATA_DIR);
  if (isPackaged) {
    return path.join(resolveExecutableDirectory({ env, executablePath }), PORTABLE_DATA_DIRECTORY_NAME);
  }
  return path.join(projectRoot, 'data');
}

function resolveLegacyDataDirectories({ isPackaged, env = process.env, homePath }) {
  if (!isPackaged || env.RANDOM_READER_DATA_DIR) return [];
  return [...new Set([
    path.join(homePath, DATA_DIRECTORY_NAME),
    path.join(homePath, LEGACY_DATA_DIRECTORY_NAME)
  ])];
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function migrateLegacyDataDirectory(sourceDirectory, targetDirectory) {
  if (!sourceDirectory || path.resolve(sourceDirectory) === path.resolve(targetDirectory)) return false;
  const sourceState = path.join(sourceDirectory, 'state.json');
  const sourceBackup = path.join(sourceDirectory, 'state.json.bak');
  if (!await exists(sourceState) && !await exists(sourceBackup)) return false;

  const targetState = path.join(targetDirectory, 'state.json');
  const targetBackup = path.join(targetDirectory, 'state.json.bak');
  if (await exists(targetState) || await exists(targetBackup)) return false;

  await fs.mkdir(targetDirectory, { recursive: true });
  await fs.cp(sourceDirectory, targetDirectory, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
  return true;
}

async function ensureDataDirectoryWritable(targetDirectory) {
  const probePath = path.join(targetDirectory, `.write-check-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.writeFile(probePath, '', { flag: 'wx' });
    await fs.unlink(probePath);
  } catch (cause) {
    try { await fs.unlink(probePath); } catch {}
    const error = new Error(`无法写入便携数据目录：${targetDirectory}\n请将图文阅读器文件夹移动到可写位置后重试。`);
    error.code = 'DATA_DIRECTORY_NOT_WRITABLE';
    error.cause = cause;
    throw error;
  }
}

module.exports = {
  DATA_DIRECTORY_NAME,
  LEGACY_DATA_DIRECTORY_NAME,
  PORTABLE_DATA_DIRECTORY_NAME,
  resolveDataDirectory,
  resolveLegacyDataDirectories,
  migrateLegacyDataDirectory,
  ensureDataDirectoryWritable
};
