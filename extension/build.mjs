// Builds the extension into extension/dist/ — that's the folder you load in Chrome.
//   node build.mjs           one build
//   node build.mjs --watch   rebuild on every save (then click "reload" on chrome://extensions)
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
cpSync("public", "dist", { recursive: true }); // manifest.json, popup.html, popup.css

// --- OCR files (milestone 2, owner: OCR) -------------------------------------
// Manifest V3 extensions may not load code from the internet, so the OCR
// engine (worker + WASM) and the English language data are copied INTO the
// extension here. src/ocr/engine.ts loads them from dist/ocr/.
// If you upgrade tesseract.js, check these file names still exist and update
// ENGINE_NAME in src/ocr/engine.ts.
const OCR_ASSETS = [
  // [from (inside node_modules), to (inside dist)]
  ["tesseract.js/dist/worker.min.js", "ocr/worker.min.js"],
  // The worker picks ONE of these three cores depending on what the CPU
  // supports (relaxed SIMD > SIMD > plain). "lstm" = the neural-net engine only.
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "ocr/core/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "ocr/core/tesseract-core-lstm.wasm.js"],
  // English, "best_int" model (the one Tesseract.js uses for the LSTM engine).
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "ocr/lang/eng.traineddata.gz"],
  // Licenses of the bundled code, shipped alongside it.
  ["tesseract.js/LICENSE.md", "ocr/licenses/tesseract.js-LICENSE.md"],
  ["tesseract.js-core/LICENSE", "ocr/licenses/tesseract.js-core-LICENSE"],
  ["tesseract.js/dist/worker.min.js.LICENSE.txt", "ocr/licenses/worker.min.js.LICENSE.txt"],
];
for (const [from, to] of OCR_ASSETS) {
  const source = `node_modules/${from}`;
  if (!existsSync(source)) {
    throw new Error(`OCR file missing: ${source}. Run "npm ci" in extension/.`);
  }
  mkdirSync(dirname(`dist/${to}`), { recursive: true });
  cpSync(source, `dist/${to}`);
}
// A test page for OCR on its own: chrome-extension://<id>/ocr-demo.html
cpSync("src/ocr/demo/ocr-demo.html", "dist/ocr-demo.html");
cpSync("src/ocr/demo/images", "dist/ocr-demo-images", { recursive: true }); // fictional samples
// ------------------------------------------------------------------------------

const common = {
  bundle: true,          // pulls in ../shared/contract.ts too
  outdir: "dist",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
  loader: { ".css": "text" }, // `import css from "x.css"` gives the file as a string
};

const builds = [
  // The popup, the service worker, the offscreen OCR page (reads the Instagram
  // photo locally) and the OCR demo page are ES modules.
  // Output names: dist/popup.js, dist/background.js, dist/offscreen.js, dist/ocr-demo.js
  {
    ...common,
    entryPoints: {
      popup: "src/popup.ts",
      background: "src/background.ts",
      offscreen: "src/offscreen.ts",
      "ocr-demo": "src/ocr/demo/demo.ts",
      dashboard: "src/dashboard/main.ts",
      history: "src/history-page.ts", // the history page (public/history.html): import, list, delete past posts // the full-page CheckYo'Self dashboard (public/dashboard.html)
    },
    format: "esm",
  },
  // Content scripts can't be ES modules, so the Instagram script is one plain file.
  { ...common, entryPoints: { instagram: "src/content/main.ts" }, format: "iife" },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log("Watching src/ ... (edits to public/ need a restart)");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
