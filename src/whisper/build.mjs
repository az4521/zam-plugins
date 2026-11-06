// Builds the Whisper voice-message transcription plugin into this repo, ready
// to commit and push:
//
//   plugins/com.zam.whisper/manifest.json   (every file + SHA-256)
//   plugins/com.zam.whisper/main.js         (the plugin bundle)
//   plugins/com.zam.whisper/assets/...      (Worker, ONNX Runtime Web wasm,
//                                            the model)
//
// and the plugin's entry in index.json. usage, from the repo root:
//   npm run build:whisper [-- --min-app <version>]

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const nm = join(root, "node_modules");
const PLUGIN_ID = "com.zam.whisper";
const out = join(root, "plugins", PLUGIN_ID);
/** The first Zam with zam.messages.annotate / refresh and zam.matrix.getMedia
 *  (raise it when the plugin starts using something newer). */
const MIN_APP_VERSION = "1.54.2";
const argMin = process.argv.indexOf("--min-app");
const minAppVersion = argMin > 0 ? process.argv[argMin + 1] : MIN_APP_VERSION;

const PLUGIN = {
    id: PLUGIN_ID,
    name: "Voice message transcription",
    version: "1.0.0",
    description:
        'Turn voice messages into text on your device (OpenAI Whisper, base model). Adds "Transcribe" to a voice message\'s menu; downloads about 105 MB the first time.',
    author: "az4521",
};

// Type-check against Zam's plugin API first (esbuild only strips types).
execFileSync(
    process.execPath,
    [join(nm, "typescript", "bin", "tsc"), "-p", join(here, "tsconfig.json")],
    { stdio: "inherit" },
);

// The model: onnx-community's ONNX port of openai/whisper-base (8-bit
// quantized), from Hugging Face at a pinned revision, checked and cached.
const MODEL_REV = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c";
const MODEL = {
    "config.json":
        "f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b",
    "generation_config.json":
        "61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0",
    "preprocessor_config.json":
        "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
    "tokenizer.json":
        "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
    "tokenizer_config.json":
        "2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573",
    "onnx/encoder_model_quantized.onnx":
        "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46",
    "onnx/decoder_model_merged_quantized.onnx":
        "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b",
};
const buildCache = join(nm, ".cache", "zam-plugin-build", "whisper-base");
const sum = (b) => createHash("sha256").update(b).digest("hex");
async function modelFile(rel) {
    const path = join(buildCache, rel);
    if (existsSync(path) && sum(readFileSync(path)) === MODEL[rel]) return path;
    const url = `https://huggingface.co/onnx-community/whisper-base/resolve/${MODEL_REV}/${rel}`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sum(bytes) !== MODEL[rel]) throw new Error(`${rel}: checksum mismatch`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets", "model"), { recursive: true });

const common = {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "inline",
    logLevel: "warning",
};
await build({
    ...common,
    entryPoints: [join(here, "src/main.ts")],
    outfile: join(out, "main.js"),
});
await build({
    ...common,
    entryPoints: [join(here, "src/worker.ts")],
    outfile: join(out, "assets/worker.js"),
});

const copy = (from, to) => {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
};
for (const rel of Object.keys(MODEL))
    copy(await modelFile(rel), join(out, "assets", "model", rel));
// transformers.js ships its own ONNX Runtime Web; this is the build it
// loads for plain CPU (wasm) inference.
const ortWeb = join(
    nm,
    "@huggingface",
    "transformers",
    "node_modules",
    "onnxruntime-web",
    "dist",
);
for (const f of [
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
])
    copy(join(ortWeb, f), join(out, "assets", f));
copy(join(here, "LICENSES.md"), join(out, "LICENSES.md"));

// ---- manifest: every file with its size and SHA-256 ----
const describe = (rel) => {
    const bytes = readFileSync(join(out, rel));
    const size = statSync(join(out, rel)).size;
    if (size > 100 * 1024 * 1024)
        throw new Error(`${rel} is over GitHub's 100 MB file limit`);
    return { path: rel, sha256: sum(bytes), size };
};
const manifest = {
    ...PLUGIN,
    entry: "main.js",
    minAppVersion,
    capabilities: ["storage"],
    assets: [
        "assets/worker.js",
        "assets/ort-wasm-simd-threaded.asyncify.mjs",
        "assets/ort-wasm-simd-threaded.asyncify.wasm",
        ...Object.keys(MODEL).map((f) => `assets/model/${f}`),
    ].map(describe),
};
writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
);
// This plugin's entry in the repo's index, the others left as they are.
{
    const indexPath = join(root, "index.json");
    const index = existsSync(indexPath)
        ? JSON.parse(readFileSync(indexPath, "utf8"))
        : { schema: 1, plugins: [] };
    const entry = { ...PLUGIN, path: `plugins/${PLUGIN_ID}` };
    const at = index.plugins.findIndex((p) => p.id === PLUGIN_ID);
    if (at >= 0) index.plugins[at] = entry;
    else index.plugins.push(entry);
    writeFileSync(indexPath, JSON.stringify(index, null, 4) + "\n");
}
copy(join(here, "README.md"), join(out, "README.md"));

const total = manifest.assets.reduce((s, f) => s + f.size, 0);
console.log(
    `Built ${PLUGIN.id} ${PLUGIN.version} (min app ${minAppVersion}) in ${relative(root, out)}`,
);
console.log(`  assets ${(total / 1e6).toFixed(1)} MB`);
