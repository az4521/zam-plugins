// src/whisper/src/decode.ts
async function decodeTo16kMono(blob) {
  const bytes = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 16e3);
  const audio = await ctx.decodeAudioData(bytes);
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i];
  }
  if (audio.numberOfChannels > 1)
    for (let i = 0; i < out.length; i++) out[i] /= audio.numberOfChannels;
  return out;
}

// src/whisper/src/model.ts
var MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx"
];
var assetPath = (file) => `assets/model/${file}`;

// src/whisper/src/main.ts
var ASSETS = {
  worker: "assets/worker.js",
  ortGlue: "assets/ort-wasm-simd-threaded.asyncify.mjs",
  ortWasm: "assets/ort-wasm-simd-threaded.asyncify.wasm"
};
var IDLE_MS = 6e4;
var KEEP = 300;
var MAX_SECONDS = 15 * 60;
var INIT = 0;
var Recognizer = class {
  constructor(zam) {
    this.zam = zam;
  }
  worker = null;
  ready = null;
  urls = [];
  pending = /* @__PURE__ */ new Map();
  nextId = 1;
  idle;
  async start() {
    const url = async (path, type) => {
      const u = await this.zam.assets.url(path, type);
      this.urls.push(u);
      return u;
    };
    const [workerUrl, ortGlue, ortWasm] = await Promise.all([
      url(ASSETS.worker, "text/javascript"),
      url(ASSETS.ortGlue, "text/javascript"),
      url(ASSETS.ortWasm, "application/wasm")
    ]);
    const files = {};
    for (const f of MODEL_FILES)
      files[f] = await url(
        assetPath(f),
        f.endsWith(".json") ? "application/json" : "application/octet-stream"
      );
    const w = new Worker(workerUrl, { type: "module" });
    this.worker = w;
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => this.fail(new Error(e.message || "worker failed"));
    await new Promise((resolve, reject) => {
      this.pending.set(INIT, { resolve: () => resolve(), reject });
      const init = { type: "init", files, ortGlue, ortWasm };
      w.postMessage(init);
    });
    return w;
  }
  onMessage(m) {
    if (m.type === "ready") {
      this.pending.get(INIT)?.resolve("");
      this.pending.delete(INIT);
    } else if (m.type === "result") {
      this.pending.get(m.id)?.resolve(m.text);
      this.pending.delete(m.id);
    } else {
      const id = m.id ?? INIT;
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.reject(new Error(m.message));
    }
  }
  fail(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.stop();
  }
  /** Whether the model is on the device already. */
  async cached() {
    const files = [
      ASSETS.worker,
      ASSETS.ortWasm,
      ...MODEL_FILES.map(assetPath)
    ];
    for (const f of files)
      if (!await this.zam.assets.cached(f)) return false;
    return true;
  }
  async transcribe(samples) {
    clearTimeout(this.idle);
    this.ready ??= this.start().catch((e) => {
      this.ready = null;
      this.stop();
      throw e;
    });
    const w = await this.ready;
    const id = this.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const m = { type: "transcribe", id, samples };
        w.postMessage(m, [samples.buffer]);
      });
    } finally {
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
    }
  }
  stop() {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }
};
var cleanup = null;
var plugin = {
  onload(zam) {
    const recognizer = new Recognizer(zam);
    const key = (roomId, eventId) => `${roomId}|${eventId}`;
    const stored = zam.storage.get(
      "transcripts",
      {}
    );
    const entries = new Map(
      Object.entries(stored).map(([k, text]) => [
        k,
        { status: "done", text }
      ])
    );
    const persist = () => {
      const done = [...entries].filter(([, e]) => e.status === "done");
      zam.storage.set(
        "transcripts",
        Object.fromEntries(
          done.slice(-KEEP).map(([k, e]) => [k, e.text])
        )
      );
    };
    const statusOf = (ctx) => entries.get(key(ctx.roomId, ctx.eventId))?.status;
    let chain = Promise.resolve();
    const run = async (roomId, eventId) => {
      const k = key(roomId, eventId);
      entries.set(k, { status: "busy", text: "" });
      zam.messages.refresh();
      try {
        const { blob } = await zam.matrix.getMedia(roomId, eventId);
        const samples = await decodeTo16kMono(blob);
        if (samples.length > MAX_SECONDS * 16e3)
          throw new Error("too long to transcribe here");
        const text = await recognizer.transcribe(samples);
        entries.set(k, {
          status: "done",
          text: text || "(no speech found)"
        });
        persist();
      } catch (e) {
        console.error("[whisper] transcription failed", e);
        entries.set(k, {
          status: "error",
          text: `Couldn't transcribe: ${e instanceof Error ? e.message : String(e)}`
        });
      }
      zam.messages.refresh();
    };
    const disposables = [
      zam.messages.addAction({
        id: "transcribe",
        label: "Transcribe",
        when: (ctx) => ctx.msgtype === "m.audio" && statusOf(ctx) !== "busy" && statusOf(ctx) !== "done",
        onSelect: async (ctx) => {
          if (!await recognizer.cached())
            zam.ui.notify({
              title: "Transcribe",
              body: "Downloading the speech model (about 80 MB), once."
            });
          chain = chain.then(() => run(ctx.roomId, ctx.eventId));
        }
      }),
      zam.messages.addAction({
        id: "hide-transcript",
        label: "Hide transcript",
        when: (ctx) => ctx.msgtype === "m.audio" && (statusOf(ctx) === "done" || statusOf(ctx) === "error"),
        onSelect: (ctx) => {
          entries.delete(key(ctx.roomId, ctx.eventId));
          persist();
          zam.messages.refresh();
        }
      }),
      zam.messages.annotate((ctx) => {
        const e = entries.get(key(ctx.roomId, ctx.eventId));
        if (!e) return null;
        return e.status === "busy" ? { text: "Transcribing\u2026", busy: true } : { text: e.text };
      })
    ];
    cleanup = () => {
      for (const d of disposables) d.dispose();
      recognizer.stop();
    };
  },
  onunload() {
    cleanup?.();
    cleanup = null;
  }
};
var main_default = plugin;
export {
  main_default as default
};
