// Library builds only: where data files (face model, hand models) are loaded from by default.
//  - Served as-is from dist/lib or dist/standalone (plain <script type="module">, a static copy of
//    dist/): the "assets/" folder next to the bundle.
//  - Re-bundled by an app's bundler (Vite, webpack, ...): the bundle's own URL says nothing about
//    where the assets are, so default to "/likeness/" and expect the app to copy
//    dist/lib/assets there (or call setAssetBase() / pass modelUrl).
// (Not `new URL("./assets/", import.meta.url)`: bundlers would try to inline that at build time.)
import { setAssetBase, useBundledWorker } from "./assets.js";

const here = import.meta.url;
const servedFromDist = /\/dist\/(lib|standalone)\/[^/]+\.js(\?.*)?$/.test(here);
setAssetBase(servedFromDist ? here.slice(0, here.lastIndexOf("/") + 1) + "assets/" : "/likeness/");
// The MediaPipe worker (assets/detect-worker.js) is found the same way.
useBundledWorker();
