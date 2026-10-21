// Builds the static site into dist/: the app from src/ plus the libraries it loads from vendor/.
import { cpSync, rmSync, writeFileSync } from "fs";

const out = "dist";
rmSync(out, { recursive: true, force: true });
cpSync("src", out, { recursive: true });
const vendor = {
  "pdfjs/pdf.min.js": "pdfjs-dist/build/pdf.min.js",
  "pdfjs/pdf.worker.min.js": "pdfjs-dist/build/pdf.worker.min.js",
  "katex/katex.min.js": "katex/dist/katex.min.js",
  "katex/katex.min.css": "katex/dist/katex.min.css",
  "katex/fonts": "katex/dist/fonts",
  "pdf-lib.min.js": "pdf-lib/dist/pdf-lib.min.js",
  // OCR for scans without a text layer, loaded only when needed: LSTM engine builds (with and
  // without SIMD) and the compact English model.
  "tesseract/tesseract.min.js": "tesseract.js/dist/tesseract.min.js",
  "tesseract/worker.min.js": "tesseract.js/dist/worker.min.js",
  "tesseract/core/tesseract-core-lstm.wasm.js": "tesseract.js-core/tesseract-core-lstm.wasm.js",
  "tesseract/core/tesseract-core-simd-lstm.wasm.js": "tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "tesseract/lang/eng.traineddata.gz": "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
};
for (const [to, from] of Object.entries(vendor)) cpSync(`node_modules/${from}`, `${out}/vendor/${to}`, { recursive: true });
writeFileSync(`${out}/.nojekyll`, "");
console.log(`Built ${out}/`);
