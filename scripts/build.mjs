#!/usr/bin/env node
/**
 * Client-side TypeScript build. Compiles `src/**\/*.ts` into `build/**\/*.mjs`
 * preserving the directory structure and native ES module imports. The
 * browser loads the compiled .mjs files directly — no bundling, matching
 * the no-build-step-at-runtime philosophy.
 *
 * Usage:
 *   node scripts/build.mjs          # one-shot build
 *   node scripts/build.mjs --watch  # watch + rebuild on change
 */

import * as esbuild from 'esbuild';
import { readdir, rm, rename, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'build');

/** Recursively collect all .ts files under src/, ignoring declaration files. */
async function collectSources(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await collectSources(p, acc);
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/** Mirror non-TS assets (worklets, etc.) into build/ so the browser can
 *  still fetch them at their expected paths. */
async function copyAssets() {
  const keep = ['audio/shared/audio-processor.js'];
  for (const rel of keep) {
    const from = join(SRC, rel);
    const to = join(OUT, rel);
    await copyFile(from, to).catch(() => {});
  }
}

// esbuild preserves `.ts` import specifiers as-is in output; browsers need `.mjs`.
// Post-process .mjs files to rewrite `./foo.ts` → `./foo.mjs` in imports.
async function rewriteImportExtensions(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await rewriteImportExtensions(p);
    } else if (e.isFile() && e.name.endsWith('.mjs')) {
      const content = await readFile(p, 'utf8');
      // Covers both static `from './foo.ts'` and dynamic `import('./foo.ts')`.
      const rewritten = content.replace(
        /((?:from|import)\s*\(?\s*['"](?:\.\.?\/)[^'"]+)\.ts(['"])/g,
        '$1.mjs$2',
      );
      if (rewritten !== content) await writeFile(p, rewritten);
    }
  }
}

/** Vendor bundle for @ricky0123/vad-web — Silero VAD WebAssembly speech
 *  classifier used by src/audio/shared/speechVad.ts. The library ships
 *  CommonJS in node_modules; the browser-direct UMD bundle externalizes
 *  onnxruntime-web. We produce a SINGLE ESM that includes both, dynamic-
 *  imported on demand from the SpeechVAD adapter so the cold-start cost
 *  is paid only when a barge loop spins up (not on every page load).
 *
 *  Output: build/vendor/vad-web.mjs (≈ a few hundred KB of JS — the wasm
 *  + onnx model + audio worklet are loaded separately at runtime from
 *  /assets/vad/, NOT bundled in here). */
async function buildVendorBundles() {
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/audio/shared/speechVad/vendor-entry.mjs')],
    outfile: join(OUT, 'vendor/vad-web.mjs'),
    format: 'esm',
    target: 'es2022',
    bundle: true,
    minify: true,
    sourcemap: false,
    logLevel: 'info',
    // Keep the wasm/onnx/worklet asset references resolved at runtime via
    // the adapter's `baseAssetPath` / `onnxWASMBasePath` options — esbuild
    // shouldn't try to inline them into the JS bundle.
    loader: { '.wasm': 'file', '.onnx': 'file' },
  });
  // SortableJS — pinned-session drag-reorder (sessionDrawer). Bundled to a
  // single ESM, dynamic-imported lazily on first pinned row.
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/vendor/sortable-entry.mjs')],
    outfile: join(OUT, 'vendor/sortable.mjs'),
    format: 'esm',
    target: 'es2022',
    bundle: true,
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });
  // Temml — LaTeX → MathML for math in agent replies (src/util/math.ts).
  // ~208 KB minified / ~58 KB over the wire, and NO font files: MathML is
  // laid out by the browser's own math renderer, so unlike KaTeX there is
  // no woff2 payload to ship into the frozen CAP bundle. Dynamic-imported
  // on the first math-bearing render — a transcript with no math never
  // fetches it. Cached by the SW in MATH_CACHE (sw.js).
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/vendor/temml-entry.mjs')],
    outfile: join(OUT, 'vendor/temml.mjs'),
    format: 'esm',
    target: 'es2022',
    bundle: true,
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });
}

/**
 * Content-hash the compiled modules (#182 / Path C2) so the service worker
 * can cache them immutably — unchanged modules are never re-downloaded
 * across deploys (the old network-first /build/* strategy re-fetched all
 * ~144 modules on every reload, painful on cellular).
 *
 * Design: filenames get a hash suffix (`main.mjs` → `main.<sha>.mjs`) but
 * module CODE is untouched — import specifiers still say `./foo.mjs`. An
 * import map (injected into build/index.html by writeHashedIndex) remaps
 * each unhashed URL to its hashed file at resolution time. This keeps every
 * file's hash independent: a leaf-module change invalidates ONE file + the
 * index, instead of cascading new hashes up the whole importer chain (which
 * is what rewriting specifiers in-place would cause). It also means runtime
 * code and smoke tests that `import('/build/foo.mjs')` by unhashed path
 * keep working — the document's import map resolves them to the same
 * (singleton) hashed module.
 *
 * Excluded from hashing:
 *  - vendor/ — vad-web.mjs and temml.mjs are versioned via the SW's
 *    VAD_CACHE / MATH_CACHE (bumped only on lib upgrades) and all three
 *    vendor bundles are dynamic-imported via runtime-computed URLs; they
 *    change ~never, so hashing buys nothing.
 *  - sourcemaps (.map) — left unrenamed; the renamed module's relative
 *    `sourceMappingURL=foo.mjs.map` comment still resolves in the same dir.
 *  - audio-processor.js — worklet loaded out-of-band (.js, not .mjs).
 */
const HASH_LEN = 10;

async function hashBuildAssets() {
  async function collect(dir, acc = []) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await collect(p, acc);
      else if (e.isFile() && e.name.endsWith('.mjs')) acc.push(p);
    }
    return acc;
  }
  const files = (await collect(OUT))
    .filter(p => !relative(OUT, p).startsWith('vendor/'))
    .sort();
  const imports = {};
  for (const p of files) {
    const rel = relative(OUT, p);
    const hash = createHash('sha256').update(await readFile(p)).digest('hex').slice(0, HASH_LEN);
    const hashedRel = rel.replace(/\.mjs$/, `.${hash}.mjs`);
    await rename(p, join(OUT, hashedRel));
    imports[`/build/${rel}`] = `/build/${hashedRel}`;
  }
  // Manifest for tooling/diagnostics; the page reads the inline import map.
  await writeFile(join(OUT, 'importmap.json'), JSON.stringify({ imports }, null, 1));
  return imports;
}

/**
 * Write build/index.html: the root index.html with (a) the import map
 * injected directly above the entry script — import maps must precede the
 * first module load and cannot be external files — and (b) the entry
 * `src` rewritten to the hashed main module (script[src] does not resolve
 * through import maps).
 *
 * The tracked root index.html stays pristine (it keeps working against an
 * unhashed `--watch` dev build); server.ts serves build/index.html when it
 * exists, and build-cap.mjs prefers it for the CAP app.html.
 */
async function writeHashedIndex(imports) {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const entry = '<script type="module" src="/build/main.mjs">';
  if (!html.includes(entry) || !imports['/build/main.mjs']) {
    throw new Error('[build] index.html entry script or hashed main.mjs missing — cannot write hashed index');
  }
  const mapTag = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
  await writeFile(
    join(OUT, 'index.html'),
    html.replace(entry, `${mapTag}\n<script type="module" src="${imports['/build/main.mjs']}">`),
  );
}

async function build({ watch }) {
  await rm(OUT, { recursive: true, force: true });
  const entries = await collectSources(SRC);
  const opts = {
    entryPoints: entries,
    outdir: OUT,
    outbase: SRC,
    format: 'esm',
    target: 'es2022',
    bundle: false,                   // native imports, not a bundle
    sourcemap: 'linked',
    outExtension: { '.js': '.mjs' }, // keep .mjs URLs stable in HTML/SW
    logLevel: 'info',
  };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log(`[build] watching ${entries.length} files under src/`);
  } else {
    await esbuild.build(opts);
    await copyAssets();
    await rewriteImportExtensions(OUT);
    await buildVendorBundles();
    await buildServerBundle();
    const imports = await hashBuildAssets();
    await writeHashedIndex(imports);
    console.log(`[build] compiled ${entries.length} files → ${relative(ROOT, OUT)}/ (${Object.keys(imports).length} hashed + import map)`);
  }
}

/**
 * Bundle the Node proxy (server.ts + proxy/**) into a single plain-JS
 * server.mjs at the repo root, so an npm-installed package can run it:
 * Node refuses --experimental-strip-types for files under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which kills `npx
 * parleyvoo` if start-all points at server.ts.
 *
 * Root outfile (not dist/) is load-bearing: server.ts derives __dirname
 * from import.meta.url and serves static assets (index.html, build/,
 * styles/) relative to it — bundling anywhere else would break every
 * static path. npm deps (ws, yaml, ...) stay external and resolve from
 * node_modules at runtime; only the local .ts graph is inlined.
 * start-all prefers server.mjs when present (published tarball), falls
 * back to strip-types server.ts (dev checkout).
 */
async function buildServerBundle() {
  await esbuild.build({
    entryPoints: [join(ROOT, 'server.ts')],
    outfile: join(ROOT, 'server.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    logLevel: 'info',
  });
}

const watch = process.argv.includes('--watch');
build({ watch }).catch(err => {
  console.error('[build] failed:', err);
  process.exit(1);
});
