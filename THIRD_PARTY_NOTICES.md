# 第三方组件与资源

MIT 许可证只适用于项目自有代码，不替代第三方许可证。

- `src/renderer/public/ocr/eng.traineddata.gz`：Tesseract 英文识别模型的压缩文件；Tesseract 语言数据采用 Apache License 2.0。全文在 `licenses/Apache-2.0.txt`，上游见 <https://github.com/tesseract-ocr/tessdata_fast>。当前目录未记录已有模型的精确上游提交，保留原文件，不宣称已核实具体版本。
- `tesseract.js` / `tesseract.js-core`：npm 提供的 OCR worker/WASM，构建脚本从依赖目录复制。许可证和版本以安装包及 `package-lock.json` 为准，生成资源不提交。
- Electron、Vite、TypeScript、Vitest、Lucide、obs-websocket-js 等依赖：保留各自许可证，依赖目录不分发。
- OBS Studio、FFmpeg：用户另行准备，不在本仓库中。

制作包含第三方运行库的安装包时，需保留所分发组件的许可和归属声明。
