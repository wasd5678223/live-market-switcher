import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const destination = resolve("src/renderer/public/ocr");
mkdirSync(destination, { recursive: true });

const assets = [
  ["node_modules/tesseract.js/dist/worker.min.js", "worker.min.js"],
  [
    "node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  ],
  [
    "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
  ],
  [
    "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
    "tesseract-core-lstm.wasm.js",
  ],
];

for (const [source, name] of assets) {
  copyFileSync(resolve(source), resolve(destination, name));
}
