# Frame-visual-reader

Windows 图文阅读器，支持文字、电子书、PDF 和漫画压缩包的本地离线阅读。

## 小白用户：下载即用

**[点击下载 Windows 版（约 167 MB）](https://github.com/xiaohuangya617/Frame-visual-reader/releases/download/v2.7.0/image-reader-v2.7.0-windows-x64.zip)**

1. 下载上面的 ZIP 文件。
2. 右键解压到一个完整的新文件夹。
3. 打开解压后的文件夹，双击 `图文阅读器.exe`。

程序运行需要保留解压后的整个文件夹，不能只复制 EXE 文件。首次启动会在程序同级目录创建 `data` 数据目录，用于保存书库、阅读进度和设置。

## 已确认功能

- 阅读 TXT、EPUB、PDF 文件。
- 阅读 ZIP、CBZ、RAR、CBR、7Z、CB7 漫画压缩包。
- 管理多个书库和合集，扫描文件夹或单个文件。
- 保存阅读进度、阅读历史、点赞和阅读状态。
- 选择 TXT 文本编码，支持 PDF 分段读取和 EPUB 流式读取。
- 漫画页面按需读取，支持阅读模式、缩放和布局设置。
- 深色/亮色模式、文件重命名、移入回收站。
- 数据备份与恢复。
- 完全离线运行，不要求登录或联网。

## 已知限制

- 当前发布构建面向 Windows x64，未提供 macOS 或 Linux 构建。
- 本仓库提供源码；依赖安装和构建需要 Node.js 与 npm，并且首次安装需要联网下载依赖。
- 不能只运行源码目录中的 HTML 文件；必须通过 Electron 启动。
- 解压后的运行目录必须保持完整，删除运行库或资源文件会导致启动或部分格式读取失败。
- 不同 TXT 编码、损坏文件、加密压缩包和特殊 PDF 的兼容性取决于文件本身，未对所有样本逐一验收。
- RAR、7Z 等格式使用第三方运行库；具体格式支持受上游库能力和文件特性影响。
- 本次验证包含源码结构、依赖锁定、JavaScript 语法和文件校验；不等同于对所有格式进行真实样本验收。

## 源码运行

目标平台为 Windows x64。请在项目根目录打开 PowerShell：

```powershell
$env:npm_config_cache = Join-Path $PWD '.cache/npm'
$env:ELECTRON_CACHE = Join-Path $PWD '.cache/electron'
$env:ELECTRON_BUILDER_CACHE = Join-Path $PWD '.cache/electron-builder'
npm.cmd ci
npm.cmd start
```

构建目录版程序：

```powershell
npm.cmd run build
```

生成的程序位于 `release/2.7.0/win-unpacked/`，运行时需要整个 `win-unpacked` 文件夹。

## 目录说明

| 路径 | 用途 |
| --- | --- |
| `src/main` | Electron 主进程、书库、文件和压缩包处理 |
| `src/preload` | 主进程与界面的安全通信接口 |
| `src/renderer` | 阅读界面、交互和样式 |
| `scripts` | PDF.js Worker 补丁、图标和目录版打包脚本 |
| `build` | 应用图标资源 |

## 版本与许可

- 当前应用版本：`2.7.0`
- 分发包版本：`1.0.0`
- 作者原创代码按 [MIT License](LICENSE) 发布，版权署名为 `xhy`。
- Electron、Vite、PDF.js、EPUB.js、7-Zip、node-unrar-js、chardet、iconv-lite、Lucide 等第三方组件仍按各自上游许可证执行，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- 本项目不声明拥有第三方组件、商标或其内容的版权。

## 版本记录

详见 [CHANGELOG.md](CHANGELOG.md)。源码文件校验值见 `SHA256SUMS.txt`。
