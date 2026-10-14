// plugins/dpdfnet/src/worklet.js
var DPDF_WIN = 960;
var DPDF_HOP = 480;
var DPDF_BINS = DPDF_WIN / 2 + 1;
var DPDF_MODEL_LAG = 4;
var DPDF_FRAME_BYTES = 4 + DPDF_BINS * 2 * 4;
function encodeFrame(seq, spec) {
  const buf = new ArrayBuffer(DPDF_FRAME_BYTES);
  new DataView(buf).setInt32(0, seq, true);
  new Float32Array(buf, 4, DPDF_BINS * 2).set(spec);
  return buf;
}
function decodeFrame(data) {
  let buf = data;
  let off = 0;
  if (ArrayBuffer.isView(data)) {
    buf = data.buffer;
    off = data.byteOffset;
    if (data.byteLength !== DPDF_FRAME_BYTES) return null;
  } else if (!(data instanceof ArrayBuffer) || data.byteLength !== DPDF_FRAME_BYTES) {
    return null;
  }
  const seq = new DataView(buf, off, 4).getInt32(0, true);
  const spec = new Float32Array(DPDF_BINS * 2);
  spec.set(new Float32Array(buf.slice(off + 4, off + DPDF_FRAME_BYTES)));
  return { seq, spec };
}
function vorbisWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.sin(0.5 * Math.PI * (i + 0.5) / (n / 2));
    w[i] = Math.sin(0.5 * Math.PI * s * s);
  }
  return w;
}
var ComplexFFT = class {
  constructor(n) {
    const factors = [];
    let m = n;
    for (const p of [4, 2, 3, 5])
      while (m % p === 0) {
        factors.push(p);
        m /= p;
      }
    if (m !== 1)
      throw new Error(`FFT size ${n} has a factor other than 2, 3, 5`);
    this.n = n;
    this.factors = factors;
    this.bufRe = new Float64Array(n);
    this.bufIm = new Float64Array(n);
    this.tw = [];
    let len = n;
    for (const p of factors) {
      const mm = len / p;
      const re = new Float64Array(mm * p);
      const im = new Float64Array(mm * p);
      for (let j = 0; j < mm; j++)
        for (let r = 0; r < p; r++) {
          const a = -2 * Math.PI * j * r / len;
          re[j * p + r] = Math.cos(a);
          im[j * p + r] = Math.sin(a);
        }
      this.tw.push({ re, im });
      len = mm;
    }
    this.roots = {};
    for (const p of new Set(factors)) {
      const re = new Float64Array(p * p);
      const im = new Float64Array(p * p);
      for (let q = 0; q < p; q++)
        for (let r = 0; r < p; r++) {
          const a = -2 * Math.PI * (q * r % p) / p;
          re[q * p + r] = Math.cos(a);
          im[q * p + r] = Math.sin(a);
        }
      this.roots[p] = { re, im };
    }
    this.tmpRe = new Float64Array(5);
    this.tmpIm = new Float64Array(5);
  }
  /** In-place forward transform of (re, im). */
  forward(re, im) {
    const n = this.n;
    let xr = re, xi = im, yr = this.bufRe, yi = this.bufIm;
    let len = n;
    let s = 1;
    const tr = this.tmpRe, ti = this.tmpIm;
    for (let pass = 0; pass < this.factors.length; pass++) {
      const p = this.factors[pass];
      const m = len / p;
      const tw = this.tw[pass];
      const rt = this.roots[p];
      for (let j = 0; j < m; j++) {
        for (let k = 0; k < s; k++) {
          for (let q = 0; q < p; q++) {
            const idx = k + s * (j + q * m);
            tr[q] = xr[idx];
            ti[q] = xi[idx];
          }
          for (let r = 0; r < p; r++) {
            let sr = 0, si = 0;
            for (let q = 0; q < p; q++) {
              const wr = rt.re[q * p + r], wi = rt.im[q * p + r];
              sr += tr[q] * wr - ti[q] * wi;
              si += tr[q] * wi + ti[q] * wr;
            }
            const twr = tw.re[j * p + r], twi = tw.im[j * p + r];
            const out = k + s * (p * j + r);
            yr[out] = sr * twr - si * twi;
            yi[out] = sr * twi + si * twr;
          }
        }
      }
      [xr, yr] = [yr, xr];
      [xi, yi] = [yi, xi];
      len = m;
      s *= p;
    }
    if (xr !== re) {
      re.set(xr);
      im.set(xi);
    }
  }
};
var RealFFT = class {
  constructor(n) {
    this.n = n;
    this.fft = new ComplexFFT(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }
  /** spec (interleaved, n/2+1 bins) = rfft(x). */
  forward(x, spec) {
    const { n, re, im } = this;
    for (let i = 0; i < n; i++) {
      re[i] = x[i];
      im[i] = 0;
    }
    this.fft.forward(re, im);
    for (let k = 0; k <= n / 2; k++) {
      spec[2 * k] = re[k];
      spec[2 * k + 1] = im[k];
    }
  }
  /** x = irfft(spec) (numpy's scaling: 1/n). */
  inverse(spec, x) {
    const { n, re, im } = this;
    const h = n / 2;
    for (let k = 0; k <= h; k++) {
      re[k] = spec[2 * k];
      im[k] = -spec[2 * k + 1];
    }
    im[0] = 0;
    im[h] = 0;
    for (let k = h + 1; k < n; k++) {
      re[k] = spec[2 * (n - k)];
      im[k] = spec[2 * (n - k) + 1];
    }
    this.fft.forward(re, im);
    for (let i = 0; i < n; i++) x[i] = re[i] / n;
  }
};
var HIST = 64;
var IN_RING = 32768;
var OUT_RING = 32768;
var DPDF_SLACK_LIMIT = 48;
var MISS_WINDOW = 200;
var MISSES_TO_WIDEN = 3;
var DpdfnetFramer = class {
  /**
   * @param send   (ArrayBuffer) => void, a binary frame for the backend
   * @param opts   { attenuationDb, slack, maxSlack }
   */
  constructor(send, opts = {}) {
    this.send = send;
    this.alpha = 10 ** (-(opts.attenuationDb ?? 100) / 20);
    this.slack = opts.slack ?? 2;
    this.slack = Math.min(this.slack, DPDF_SLACK_LIMIT);
    this.maxSlack = Math.min(
      DPDF_SLACK_LIMIT,
      Math.max(this.slack, opts.maxSlack ?? 8)
    );
    this.maxInflight = this.maxSlack + 4;
    this.fft = new RealFFT(DPDF_WIN);
    this.window = vorbisWindow(DPDF_WIN);
    this.input = new Float32Array(IN_RING);
    this.taken = 0;
    this.sinceFrame = 0;
    this.frame = new Float32Array(DPDF_WIN);
    this.time = new Float32Array(DPDF_WIN);
    this.noisy = Array.from(
      { length: HIST },
      () => new Float32Array(DPDF_BINS * 2)
    );
    this.result = Array.from(
      { length: HIST },
      () => new Float32Array(DPDF_BINS * 2)
    );
    this.resultSeq = new Int32Array(HIST).fill(-1);
    this.mix = new Float32Array(DPDF_BINS * 2);
    this.gains = new Float32Array(DPDF_BINS).fill(this.alpha);
    this.ola = new Float32Array(DPDF_WIN);
    this.out = new Float32Array(OUT_RING);
    this.next = 0;
    this.nextSynth = 0;
    this.contentPos = 0;
    this.gap = DPDF_WIN + this.slack * DPDF_HOP;
    this.sent = 0;
    this.received = 0;
    this.misses = 0;
    this.late = 0;
    this.skipped = 0;
    this.missLog = new Int32Array(MISSES_TO_WIDEN).fill(-1e9);
    this.missLogPos = 0;
  }
  /** Output delay in samples: content lags input by this much. */
  get delay() {
    return DPDF_WIN + this.slack * DPDF_HOP + DPDF_MODEL_LAG * DPDF_HOP;
  }
  /** A backend answer (binary frame). */
  receive(data) {
    const f = decodeFrame(data);
    if (!f) return;
    this.received++;
    if (f.seq < this.nextSynth || f.seq >= this.next) {
      this.late++;
      return;
    }
    const i = f.seq % HIST;
    this.result[i].set(f.spec);
    this.resultSeq[i] = f.seq;
  }
  /** One render block: `input` in, enhanced to `out`, aligned dry input to
   *  `dry` (either output may be null). */
  process(out, dry, input) {
    const len = out ? out.length : dry ? dry.length : input ? input.length : 128;
    for (let i = 0; i < len; i++) {
      this.input[this.taken % IN_RING] = input ? input[i] : 0;
      this.taken++;
      if (++this.sinceFrame >= DPDF_HOP && this.taken >= DPDF_WIN) {
        this.sinceFrame = 0;
        this.produce();
      }
    }
    for (let i = 0; i < len; i++) {
      let y = 0;
      let d = 0;
      if (this.gap > 0) {
        this.gap--;
      } else if (this.contentPos < this.nextSynth * DPDF_HOP) {
        y = this.out[this.contentPos % OUT_RING];
        const src = this.contentPos - DPDF_MODEL_LAG * DPDF_HOP;
        if (src >= 0) d = this.input[src % IN_RING];
        this.contentPos++;
      }
      if (out) out[i] = y;
      if (dry) dry[i] = d;
    }
  }
  produce() {
    const t = this.next++;
    const start = this.taken - DPDF_WIN;
    for (let i = 0; i < DPDF_WIN; i++)
      this.frame[i] = this.input[(start + i) % IN_RING] * this.window[i];
    const spec = this.noisy[t % HIST];
    this.fft.forward(this.frame, spec);
    this.resultSeq[t % HIST] = -1;
    if (this.sent - this.received < this.maxInflight) {
      this.sent++;
      this.send(encodeFrame(t, spec));
    } else {
      this.skipped++;
    }
    while (this.nextSynth <= t - this.slack) this.synth(this.nextSynth++);
  }
  synth(f) {
    const i = f % HIST;
    const alpha = this.alpha;
    const mix = this.mix;
    const lagF = f - DPDF_MODEL_LAG;
    const noisy = lagF >= 0 ? this.noisy[lagF % HIST] : null;
    if (this.resultSeq[i] === f) {
      const e = this.result[i];
      for (let k = 0; k < DPDF_BINS; k++) {
        const nr = noisy ? noisy[2 * k] : 0;
        const ni = noisy ? noisy[2 * k + 1] : 0;
        const er = e[2 * k], ei = e[2 * k + 1];
        const mr = alpha * nr + (1 - alpha) * er;
        const mi = alpha * ni + (1 - alpha) * ei;
        mix[2 * k] = mr;
        mix[2 * k + 1] = mi;
        const nm = nr * nr + ni * ni;
        this.gains[k] = nm > 1e-20 ? Math.min(1, Math.sqrt((mr * mr + mi * mi) / nm)) : alpha;
      }
    } else {
      this.misses++;
      this.missLog[this.missLogPos] = f;
      this.missLogPos = (this.missLogPos + 1) % MISSES_TO_WIDEN;
      for (let k = 0; k < DPDF_BINS; k++) {
        const g = this.gains[k];
        mix[2 * k] = noisy ? noisy[2 * k] * g : 0;
        mix[2 * k + 1] = noisy ? noisy[2 * k + 1] * g : 0;
      }
      const oldest = this.missLog[this.missLogPos];
      if (f - oldest < MISS_WINDOW && this.slack < this.maxSlack) {
        this.slack++;
        this.gap += DPDF_HOP;
        this.missLog.fill(-1e9);
      }
    }
    this.fft.inverse(mix, this.time);
    const ola = this.ola;
    for (let n = 0; n < DPDF_WIN; n++)
      ola[n] += this.time[n] * this.window[n];
    const base = f * DPDF_HOP;
    for (let n = 0; n < DPDF_HOP; n++)
      this.out[(base + n) % OUT_RING] = ola[n];
    ola.copyWithin(0, DPDF_HOP);
    ola.fill(0, DPDF_WIN - DPDF_HOP);
  }
  stats() {
    return {
      frames: this.next,
      sent: this.sent,
      received: this.received,
      misses: this.misses,
      late: this.late,
      skipped: this.skipped,
      slack: this.slack
    };
  }
};
if (typeof registerProcessor === "function") {
  registerProcessor(
    "zam-dpdfnet",
    class extends AudioWorkletProcessor {
      constructor(options) {
        super();
        const o = options.processorOptions ?? {};
        this.backend = null;
        this.core = new DpdfnetFramer(
          (buf) => this.backend?.postMessage(buf),
          o
        );
        this.blocks = 0;
        this.port.onmessage = (e) => {
          const m = e.data;
          if (m instanceof ArrayBuffer || ArrayBuffer.isView(m)) {
            this.core.receive(m);
          } else if (m?.type === "backend") {
            const port = e.ports?.[0] ?? m.port;
            port.onmessage = (ev) => this.core.receive(ev.data);
            this.backend = port;
          } else if (m?.type === "relay") {
            this.backend = this.port;
          } else if (m?.type === "stop") {
            if (this.backend && this.backend !== this.port) {
              this.backend.postMessage(
                JSON.stringify({ type: "close" })
              );
              this.backend.close();
            }
            this.backend = null;
          }
        };
      }
      process(inputs, outputs) {
        this.core.process(
          outputs[0]?.[0],
          outputs[1]?.[0],
          inputs[0]?.[0]
        );
        if (++this.blocks % 375 === 0)
          this.port.postMessage({
            type: "stats",
            ...this.core.stats()
          });
        return true;
      }
    }
  );
}

// plugins/dpdfnet/src/protocol.ts
var control = (m) => JSON.stringify(m);
function parseControl(data) {
  if (typeof data !== "string") return null;
  try {
    const m = JSON.parse(data);
    return m && typeof m.type === "string" ? m : null;
  } catch {
    return null;
  }
}
function freshState(init) {
  const s = new Float32Array(init.stateSize);
  s.set(init.erbNormInit, 0);
  s.set(init.specNormInit, init.erbNormInit.length);
  return s;
}

// plugins/dpdfnet/src/worker.ts
var SPEC_SHAPE = [1, 1, DPDF_BINS, 2];
var ort = null;
var session = null;
async function load(m) {
  ort = await import(
    /* @vite-ignore */
    m.ortModuleUrl
  );
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = m.ortWasm;
  ort.env.wasm.wasmPaths = { mjs: m.ortGlueUrl };
  return ort.InferenceSession.create(new Uint8Array(m.model), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  });
}
function serve(port) {
  let init = null;
  let state = null;
  let queue = Promise.resolve();
  const reply = (m) => port.postMessage(control(m));
  port.onmessage = (e) => {
    const data = e.data;
    if (typeof data === "string") {
      const msg = parseControl(data);
      if (msg?.type === "init") {
        init = msg;
        state = freshState(msg);
        if (!session) {
          reply({
            type: "error",
            message: "the Worker isn't loaded"
          });
          return;
        }
        session.then(
          () => reply({ type: "ready", backend: "worker" }),
          (err) => reply({ type: "error", message: String(err) })
        );
      } else if (msg?.type === "reset" && init) {
        const i = init;
        queue = queue.then(() => {
          state = freshState(i);
        });
      } else if (msg?.type === "close") {
        port.close();
      }
      return;
    }
    const frame = decodeFrame(data);
    if (!frame || !session || !ort) return;
    const s = session;
    const o = ort;
    queue = queue.then(async () => {
      const sess = await s;
      const out = await sess.run({
        spec: new o.Tensor("float32", frame.spec, SPEC_SHAPE),
        state_in: new o.Tensor("float32", state, [state.length])
      });
      state = out.state_out.data;
      port.postMessage(
        encodeFrame(frame.seq, out.spec_e.data)
      );
    }).catch((err) => reply({ type: "error", message: String(err) }));
  };
}
self.onmessage = (e) => {
  const m = e.data;
  if (m?.type === "load") {
    session = load(m);
    session.then(
      () => self.postMessage({ type: "loaded" }),
      (err) => {
        session = null;
        self.postMessage({ type: "load-error", message: String(err) });
      }
    );
  } else if (m?.type === "connect" && e.ports[0]) {
    serve(e.ports[0]);
  }
};
