/**
 * Entry-point for the bundled Temml ESM produced at build time
 * (scripts/build.mjs → build/vendor/temml.mjs).
 *
 * Temml converts LaTeX → MathML. MathML is rendered NATIVELY by
 * Safari/WKWebView, Chrome and Firefox, so unlike KaTeX there are no
 * woff2 font files to ship alongside and no CSS layout engine in JS —
 * which matters because the CAP iOS app serves a bundle frozen on the
 * device, where every extra asset is a download he pays for and a thing
 * that can 404 offline.
 *
 * esbuild resolves `temml` from node_modules and emits a single bundled
 * ESM at /build/vendor/temml.mjs, dynamic-imported on first math-bearing
 * render by src/util/math.ts. A transcript with no math never fetches it.
 */
import Temml from 'temml';

export default Temml;
