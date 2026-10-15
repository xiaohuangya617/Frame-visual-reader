const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { path7za } = require('7zip-bin');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const releaseRoot = path.join(projectRoot, 'release', version);
const sourceDirectory = path.join(releaseRoot, 'win-unpacked');
const executablePath = path.join(sourceDirectory, '图文阅读器.exe');
const appAsarPath = path.join(sourceDirectory, 'resources', 'app.asar');
const BUILD_INPUT_RELATIVE_PATHS = Object.freeze([
  'src',
  'dist-renderer',
  'package.json',
  'package-lock.json',
  'vite.config.mjs',
  path.join('build', 'icon.png'),
  path.join('build', 'icon.ico')
]);

function resolveDesktopDirectory() {
  if (process.env.RANDOM_READER_DESKTOP) {
    return path.resolve(process.env.RANDOM_READER_DESKTOP);
  }

  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', '[Environment]::GetFolderPath(\'Desktop\')'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (output) return output;
    } catch {
      // Fall back to the conventional location when the shell is unavailable.
    }
  }

  return path.join(os.homedir(), 'Desktop');
}

function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--existing')) {
    return 'existing';
  }
  if (args.length === 1 && args[0] === '--preflight') {
    return 'preflight';
  }
  throw new Error('参数无效。可用参数：--preflight、--existing');
}

function ensureArchiveTargetAvailable(archivePath, fileSystem = fs) {
  if (fileSystem.existsSync(archivePath)) {
    throw new Error(`目标压缩包已存在，为避免覆盖请先指定新版本或删除旧文件：${archivePath}`);
  }
}

function latestModification(targetPath, fileSystem = fs) {
  if (!fileSystem.existsSync(targetPath)) {
    throw new Error(`构建输入不存在：${targetPath}`);
  }

  const stats = fileSystem.statSync(targetPath);
  let latest = { path: targetPath, mtimeMs: stats.mtimeMs };
  if (!stats.isDirectory()) return latest;

  for (const name of fileSystem.readdirSync(targetPath)) {
    const candidate = latestModification(path.join(targetPath, name), fileSystem);
    if (candidate.mtimeMs > latest.mtimeMs) latest = candidate;
  }
  return latest;
}

function assertBuildIsFresh(applicationArchivePath, inputPaths, fileSystem = fs) {
  if (!fileSystem.existsSync(applicationArchivePath)) {
    throw new Error(`未找到构建文件：${applicationArchivePath}`);
  }

  const buildMtimeMs = fileSystem.statSync(applicationArchivePath).mtimeMs;
  let latestInput = null;
  for (const inputPath of inputPaths) {
    const candidate = latestModification(inputPath, fileSystem);
    if (!latestInput || candidate.mtimeMs > latestInput.mtimeMs) latestInput = candidate;
  }

  if (latestInput && latestInput.mtimeMs > buildMtimeMs) {
    throw new Error(
      `现有构建已过期：${latestInput.path} 比 app.asar 更新。请运行 npm.cmd run package:folder 完整发布。`
    );
  }
  return { buildMtimeMs, latestInput };
}

function createArchiveArguments(archivePath) {
  return ['a', '-tzip', '-mx=9', '-mmt=on', '-bsp1', archivePath, 'win-unpacked'];
}

function createIntegrityArguments(archivePath) {
  return ['t', '-bsp1', archivePath];
}

function run7Zip(args) {
  const result = spawnSync(path7za, args, {
    cwd: releaseRoot,
    stdio: 'inherit',
    windowsHide: true
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`7-Zip 执行失败，退出码：${result.status}`);
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function formatBeijingTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

function calculateSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

async function main(args = process.argv.slice(2)) {
  const mode = parseMode(args);
  const desktopDirectory = resolveDesktopDirectory();
  const archivePath = path.join(desktopDirectory, `图文阅读器-${version}-文件夹版.zip`);
  ensureArchiveTargetAvailable(archivePath);

  if (mode === 'preflight') {
    console.log(`发布预检通过，目标压缩包尚不存在：${archivePath}`);
    return;
  }

  if (!fs.existsSync(executablePath)) {
    throw new Error(`未找到文件夹版入口：${executablePath}`);
  }
  assertBuildIsFresh(
    appAsarPath,
    BUILD_INPUT_RELATIVE_PATHS.map((relativePath) => path.join(projectRoot, relativePath))
  );

  fs.mkdirSync(desktopDirectory, { recursive: true });
  const startedAt = Date.now();
  console.log(`压缩开始时间：${formatBeijingTime(new Date(startedAt))}`);
  console.log(`开始最高等级压缩：${archivePath}`);
  run7Zip(createArchiveArguments(archivePath));
  console.log(`压缩完成，耗时：${formatDuration(Date.now() - startedAt)}`);

  console.log('正在执行 ZIP 完整性检查……');
  run7Zip(createIntegrityArguments(archivePath));
  const archiveStats = fs.statSync(archivePath);
  if (!archiveStats.isFile() || archiveStats.size === 0) {
    throw new Error(`压缩包为空或不可用：${archivePath}`);
  }
  const sha256 = await calculateSha256(archivePath);
  console.log(`文件夹版压缩包已生成：${archivePath}`);
  console.log(`文件大小：${archiveStats.size} 字节`);
  console.log(`SHA-256：${sha256}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`发布失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BUILD_INPUT_RELATIVE_PATHS,
  parseMode,
  ensureArchiveTargetAvailable,
  latestModification,
  assertBuildIsFresh,
  createArchiveArguments,
  createIntegrityArguments,
  formatDuration,
  formatBeijingTime,
  calculateSha256,
  main
};
