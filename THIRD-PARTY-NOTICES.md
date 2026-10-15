# 第三方组件声明

本项目是编译后的 Windows 运行包。以下组件的许可证随运行目录或应用资源一同保留，使用和再分发时应继续遵守各自条款。

| 组件 | 版本/来源线索 | 许可证材料 |
| --- | --- | --- |
| Electron / Chromium | 随 Windows 运行包分发 | `LICENSE.electron.txt`、`LICENSES.chromium.html` |
| 7zip-bin | 5.2.0 | `resources/app.asar.unpacked/node_modules/7zip-bin/LICENSE.txt` |
| epubjs | 0.3.93 | `resources/app.asar` 内 `node_modules/epubjs/license` |
| JSZip | 随应用资源分发 | `resources/app.asar` 内 `node_modules/jszip/LICENSE.markdown` |
| node-unrar-js | 2.0.2 | `resources/app.asar.unpacked/node_modules/node-unrar-js/LICENSE.md` |
| pdfjs-dist | 6.3.289 | `resources/app.asar` 内 `node_modules/pdfjs-dist/LICENSE` 及其附属许可证 |
| chardet、iconv-lite、lucide 及其他依赖 | 随应用资源分发 | 各依赖目录中的 `LICENSE`、`license.md` 或 `NOTICE` 文件 |

应用资源中的依赖版本来自随包保留的 `package.json` 元数据。此文件不替代任何上游许可证原文；如许可证条款与本说明冲突，以组件随附的许可证原文为准。

