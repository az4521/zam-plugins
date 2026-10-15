// src/dpdfnet/src/worklet.js
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
    const start2 = this.taken - DPDF_WIN;
    for (let i = 0; i < DPDF_WIN; i++)
      this.frame[i] = this.input[(start2 + i) % IN_RING] * this.window[i];
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

// src/dpdfnet/model/dpdfnet2_48khz_hr.init.json
var dpdfnet2_48khz_hr_init_default = {
  stateSize: 56436,
  erbNormInit: [
    -32.55730056762695,
    -34.82120132446289,
    -38.853599548339844,
    -39.87860107421875,
    -40.743499755859375,
    -41.52640151977539,
    -42.255001068115234,
    -42.40840148925781,
    -42.430999755859375,
    -42.645999908447266,
    -43.03350067138672,
    -43.6703987121582,
    -44.5702018737793,
    -45.3494987487793,
    -46.00849914550781,
    -46.455501556396484,
    -46.658599853515625,
    -46.534400939941406,
    -46.615501403808594,
    -46.80839920043945,
    -46.99290084838867,
    -47.160099029541016,
    -47.25270080566406,
    -47.3922004699707,
    -47.64030075073242,
    -47.92409896850586,
    -48.150299072265625,
    -48.300899505615234,
    -48.230098724365234,
    -48.33219909667969,
    -48.75600051879883,
    -48.99829864501953,
    -48.93349838256836,
    -48.96620178222656,
    -49.14590072631836,
    -49.34199905395508,
    -49.721099853515625,
    -50.011600494384766,
    -49.938499450683594,
    -49.95819854736328,
    -50.26300048828125,
    -50.599098205566406,
    -50.696800231933594,
    -50.680198669433594,
    -50.69850158691406,
    -50.7848014831543,
    -51.015899658203125,
    -51.204898834228516,
    -51.16350173950195,
    -51.11429977416992,
    -51.22529983520508,
    -51.358699798583984,
    -51.46379852294922,
    -51.624900817871094,
    -51.695899963378906,
    -51.6421012878418,
    -51.78960037231445,
    -52.10390090942383,
    -52.222801208496094,
    -52.24489974975586,
    -52.37480163574219,
    -52.483299255371094,
    -52.642799377441406,
    -52.83359909057617,
    -52.924598693847656,
    -52.9567985534668,
    -53.0166015625,
    -53.09360122680664,
    -53.22309875488281,
    -53.321998596191406,
    -53.291900634765625,
    -53.25979995727539,
    -53.32509994506836,
    -53.40570068359375,
    -53.434600830078125,
    -53.47010040283203,
    -53.50490188598633,
    -53.54460144042969,
    -53.62799835205078,
    -53.73210144042969,
    -53.856300354003906,
    -53.921199798583984,
    -53.98469924926758,
    -54.04309844970703,
    -54.21670150756836,
    -54.4015998840332,
    -54.489601135253906,
    -54.584800720214844,
    -54.66389846801758,
    -54.76240158081055,
    -54.93579864501953,
    -55.11970138549805,
    -55.227500915527344,
    -55.31560134887695,
    -55.416500091552734,
    -55.53990173339844,
    -55.67639923095703,
    -55.739498138427734,
    -55.74769973754883,
    -55.847900390625,
    -55.97439956665039,
    -56.042999267578125,
    -56.08599853515625,
    -56.16400146484375,
    -56.23630142211914,
    -56.26279830932617,
    -56.37779998779297,
    -56.47600173950195,
    -56.511600494384766,
    -56.56529998779297,
    -56.661399841308594,
    -56.70719909667969,
    -56.746299743652344,
    -56.83409881591797,
    -56.87200164794922,
    -56.91469955444336,
    -56.98649978637695,
    -57.01850128173828,
    -57.0088005065918,
    -57.042198181152344,
    -57.1057014465332,
    -57.15739822387695,
    -57.19390106201172,
    -57.20759963989258,
    -57.213401794433594,
    -57.22740173339844,
    -57.27439880371094,
    -57.31800079345703,
    -57.27980041503906,
    -57.31230163574219,
    -57.342498779296875,
    -57.30120086669922,
    -57.273399353027344,
    -57.28369903564453,
    -57.29240036010742,
    -57.24810028076172,
    -57.232398986816406,
    -57.285301208496094,
    -57.28010177612305,
    -57.227500915527344,
    -57.224098205566406,
    -57.22669982910156,
    -57.2223014831543,
    -57.22990036010742,
    -57.22129821777344,
    -57.19350051879883,
    -57.21670150756836,
    -57.26940155029297,
    -57.26919937133789,
    -57.23590087890625,
    -57.2661018371582,
    -57.283199310302734,
    -57.28450012207031,
    -57.292301177978516,
    -57.300201416015625,
    -57.30820083618164,
    -57.297698974609375,
    -57.34809875488281,
    -57.368900299072266,
    -57.36399841308594,
    -57.375701904296875,
    -57.42319869995117,
    -57.44380187988281,
    -57.461700439453125,
    -57.51470184326172,
    -57.52939987182617,
    -57.50809860229492,
    -57.538299560546875,
    -57.59320068359375,
    -57.567100524902344,
    -57.55149841308594,
    -57.558101654052734,
    -57.5630989074707,
    -57.55149841308594,
    -57.55550003051758,
    -57.59379959106445,
    -57.60459899902344,
    -57.60499954223633,
    -57.617698669433594,
    -57.623600006103516,
    -57.632198333740234,
    -57.65570068359375,
    -57.70249938964844,
    -57.733699798583984,
    -57.76789855957031,
    -57.82099914550781,
    -57.859500885009766,
    -57.86399841308594,
    -57.88800048828125,
    -57.926700592041016,
    -57.97140121459961,
    -57.9995002746582,
    -58.01649856567383,
    -58.03810119628906,
    -58.071998596191406,
    -58.115501403808594,
    -58.15250015258789,
    -58.15380096435547,
    -58.17530059814453,
    -58.207698822021484,
    -58.22779846191406,
    -58.23619842529297,
    -58.22090148925781,
    -58.20600128173828,
    -58.22959899902344,
    -58.27280044555664,
    -58.30939865112305,
    -58.35060119628906,
    -58.38130187988281,
    -58.41400146484375,
    -58.44459915161133,
    -58.44969940185547,
    -58.47209930419922,
    -58.49720001220703,
    -58.525299072265625,
    -58.53010177612305,
    -58.532798767089844,
    -58.56269836425781,
    -58.59600067138672,
    -58.62329864501953,
    -58.660400390625,
    -58.717201232910156,
    -58.770599365234375,
    -58.820899963378906,
    -58.8838996887207,
    -58.94350051879883,
    -59.00270080566406,
    -59.062599182128906,
    -59.124000549316406,
    -59.2067985534668,
    -59.27830123901367,
    -59.33700180053711,
    -59.40019989013672,
    -59.43170166015625,
    -59.472999572753906,
    -59.48500061035156,
    -59.52190017700195,
    -59.566200256347656,
    -59.539798736572266,
    -59.538700103759766,
    -59.588199615478516,
    -59.611900329589844,
    -59.60490036010742,
    -59.60749816894531,
    -59.652000427246094,
    -59.67649841308594,
    -59.694801330566406,
    -59.732601165771484,
    -59.79669952392578,
    -59.84989929199219,
    -59.90530014038086,
    -59.93880081176758,
    -60.02289962768555,
    -60.09280014038086,
    -60.12379837036133,
    -60.1692008972168,
    -60.26150131225586,
    -60.31489944458008,
    -60.34109878540039,
    -60.409698486328125,
    -60.484500885009766,
    -60.500701904296875,
    -60.53969955444336,
    -60.609100341796875,
    -60.65589904785156,
    -60.696800231933594,
    -60.7422981262207,
    -60.81420135498047,
    -60.86429977416992,
    -60.909000396728516,
    -60.934200286865234,
    -60.975399017333984,
    -61.0166015625,
    -61.04439926147461,
    -61.08890151977539,
    -61.149898529052734,
    -61.18109893798828,
    -61.2333984375,
    -61.27790069580078,
    -61.31230163574219,
    -61.372798919677734,
    -61.43560028076172,
    -61.462100982666016,
    -61.52220153808594,
    -61.587501525878906,
    -61.632598876953125,
    -61.65330123901367,
    -61.7239990234375,
    -61.76530075073242,
    -61.782501220703125,
    -61.832698822021484,
    -61.87229919433594,
    -61.90879821777344,
    -61.91669845581055,
    -61.93619918823242,
    -62.00170135498047,
    -62.045799255371094,
    -62.06549835205078,
    -62.08330154418945,
    -62.11800003051758,
    -62.13460159301758,
    -62.1609992980957,
    -62.16849899291992,
    -62.21730041503906,
    -62.27159881591797,
    -62.3036003112793,
    -62.34120178222656,
    -62.38410186767578,
    -62.431800842285156,
    -62.4739990234375,
    -62.5171012878418,
    -62.54570007324219,
    -62.520198822021484,
    -62.62770080566406,
    -62.71080017089844,
    -62.77370071411133,
    -62.841400146484375,
    -62.8911018371582,
    -62.9369010925293,
    -62.972198486328125,
    -62.99660110473633,
    -63.0275993347168,
    -63.08919906616211,
    -63.14910125732422,
    -63.17470169067383,
    -63.22639846801758,
    -63.277099609375,
    -63.29669952392578,
    -63.30730056762695,
    -63.34859848022461,
    -63.391300201416016,
    -63.431400299072266,
    -63.46030044555664,
    -63.48440170288086,
    -63.54159927368164,
    -63.594398498535156,
    -63.62289810180664,
    -63.65850067138672,
    -63.70600128173828,
    -63.735801696777344,
    -63.76449966430664,
    -63.797000885009766,
    -63.82619857788086,
    -63.86320114135742,
    -63.90719985961914,
    -63.94060134887695,
    -63.99340057373047,
    -64.05889892578125,
    -64.09159851074219,
    -64.12809753417969,
    -64.18370056152344,
    -64.23629760742188,
    -64.2770004272461,
    -64.29340362548828,
    -64.32250213623047,
    -64.38680267333984,
    -64.42340087890625,
    -64.4572982788086,
    -64.49720001220703,
    -64.55509948730469,
    -64.58679962158203,
    -64.62329864501953,
    -64.68479919433594,
    -64.72989654541016,
    -64.75499725341797,
    -64.81060028076172,
    -64.88520050048828,
    -64.95670318603516,
    -65.03600311279297,
    -65.09449768066406,
    -65.17310333251953,
    -65.24440002441406,
    -65.2854995727539,
    -65.3230972290039,
    -65.37650299072266,
    -65.44670104980469,
    -65.51000213623047,
    -65.58360290527344,
    -65.67430114746094,
    -65.76110076904297,
    -65.83540344238281,
    -65.89350128173828,
    -65.9760971069336,
    -66.05449676513672,
    -66.12439727783203,
    -66.1969985961914,
    -66.28739929199219,
    -66.36710357666016,
    -66.42530059814453,
    -66.4988021850586,
    -66.58219909667969,
    -66.66470336914062,
    -66.75980377197266,
    -66.84429931640625,
    -66.9458999633789,
    -67.02040100097656,
    -67.10240173339844,
    -67.19039916992188,
    -67.28900146484375,
    -67.39199829101562,
    -67.4990005493164,
    -67.65599822998047,
    -67.79119873046875,
    -67.88710021972656,
    -67.9999008178711,
    -68.12190246582031,
    -68.20429992675781,
    -68.29329681396484,
    -68.38259887695312,
    -68.4811019897461,
    -68.60070037841797,
    -68.71189880371094,
    -68.82209777832031,
    -68.9301986694336,
    -69.04930114746094,
    -69.17500305175781,
    -69.277099609375,
    -69.3843994140625,
    -69.4990005493164,
    -69.60359954833984,
    -69.7136001586914,
    -69.8386001586914,
    -69.95230102539062,
    -70.06279754638672,
    -70.17459869384766,
    -70.29019927978516,
    -70.39779663085938,
    -70.47959899902344,
    -70.53350067138672,
    -70.5188980102539,
    -70.42410278320312,
    -70.28119659423828,
    -70.10929870605469,
    -70.0510025024414,
    -70.19930267333984,
    -70.3490982055664,
    -70.50810241699219,
    -70.74759674072266,
    -71.00360107421875,
    -71.24590301513672,
    -71.5072021484375,
    -71.7031021118164,
    -71.90480041503906,
    -72.14790344238281,
    -72.3301010131836,
    -72.60340118408203,
    -72.84380340576172,
    -73.2155990600586,
    -73.58529663085938,
    -73.76249694824219,
    -74.06390380859375,
    -74.50640106201172,
    -74.93599700927734,
    -75.37419891357422,
    -75.77629852294922,
    -76.12460327148438,
    -76.46240234375,
    -76.77649688720703,
    -77.13169860839844,
    -77.51899719238281,
    -77.89540100097656,
    -78.2605972290039,
    -78.68479919433594,
    -79.14749908447266,
    -79.63269805908203,
    -80.1250991821289,
    -80.62120056152344,
    -81.17849731445312,
    -81.78389739990234,
    -82.39600372314453,
    -83.0165023803711,
    -83.6427993774414,
    -84.26439666748047,
    -84.94170379638672,
    -85.66929626464844,
    -86.30480194091797,
    -86.88849639892578,
    -87.50309753417969,
    -88.15440368652344,
    -88.77860260009766,
    -90.18599700927734
  ],
  specNormInit: [
    0.00478440010920167,
    0.002314500045031309,
    0.0011381000513210893,
    0.0013409999664872885,
    0.0016283999430015683,
    0.00136009999550879,
    0.0010599000379443169,
    0.0010850999969989061,
    0.0011903999838978052,
    0.0011747999815270305,
    0.001115799997933209,
    999439973384142e-18,
    8141699945554137e-19,
    6705300183966756e-19,
    5537099787034094e-19,
    4880499909631908e-19,
    448050006525591e-18,
    4490200080908835e-19,
    4436699964571744e-19,
    41298000724054873e-20,
    3924200136680156e-19,
    38549001328647137e-20,
    38750001112930477e-20,
    3864399914164096e-19,
    36546000046655536e-20,
    3396199899725616e-19,
    3168300027027726e-19,
    30447999597527087e-20,
    30707998666912317e-20,
    2974699891638011e-19,
    2656900032889098e-19,
    24228999973274767e-20,
    24167999799828976e-20,
    23998999677132815e-20,
    2273900026921183e-19,
    21208000543992966e-20,
    18910999642685056e-20,
    172610001754947e-18,
    17518000095151365e-20,
    17159999697469175e-20,
    1555299968458712e-19,
    14251000538934022e-20,
    13751999358646572e-20,
    13576999481301755e-20,
    13799000589642674e-20,
    13611999747809023e-20,
    12774000060744584e-20,
    1231299975188449e-19,
    12492999667301774e-20,
    12583000352606177e-20,
    12150000111432746e-20,
    11667000217130408e-20,
    11218999861739576e-20,
    1079299981938675e-19,
    10795999696711078e-20,
    11018999794032425e-20,
    10533000022405759e-20,
    950739995460026e-19,
    9116000001085922e-20,
    916700009838678e-19,
    8826099656289443e-20,
    8542399882571772e-20,
    8125099702738225e-20,
    765369986766018e-19,
    753679996705614e-19,
    7462099893018603e-20,
    7329400250455365e-20,
    7225800072774291e-20,
    7084300159476697e-20,
    6935500277904794e-20,
    6945500354049727e-20,
    704970007063821e-19,
    697089999448508e-19,
    6811400089645758e-20,
    6921699969097972e-20,
    6902399763930589e-20,
    6772400229237974e-20,
    6778499664505944e-20,
    6771500193281099e-20,
    6665399996563792e-20,
    6415299867512658e-20,
    6238999776542187e-20,
    6197299808263779e-20,
    6169900007080287e-20,
    60427999414969236e-21,
    5866100036655553e-20,
    57287001254735515e-21,
    55862001318018883e-21,
    55363001592922956e-21,
    5470199903356843e-20,
    5288900138111785e-20,
    4961900049238466e-20,
    48313999286619946e-21,
    477659996249713e-19,
    4663299841922708e-20,
    4595800055540167e-20
  ]
};

// src/dpdfnet/src/protocol.ts
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
var MODEL_INIT = dpdfnet2_48khz_hr_init_default;
function freshState(init) {
  const s = new Float32Array(init.stateSize);
  s.set(init.erbNormInit, 0);
  s.set(init.specNormInit, init.erbNormInit.length);
  return s;
}

// src/dpdfnet/src/webgpu/engine.ts
var DPDF_BINS2 = 481;
var C = 64;
var SPEC = DPDF_BINS2 * 2;
var FRAME_WRAP = 60;
var STAGING = 8;
var Weights = class {
  constructor(src) {
    this.src = src;
  }
  parts = [];
  size = 0;
  tensor(name, shape) {
    const t = this.src.get(name);
    if (!t) throw new Error(`model has no ${name}`);
    const n = shape.reduce((a, b) => a * b, 1);
    if (t.data.length !== n) {
      throw new Error(
        `${name}: expected ${shape.join("x")}, got ${t.dims.join("x")}`
      );
    }
    return t.data;
  }
  add(data) {
    const off = this.size;
    this.parts.push(data);
    this.size += data.length;
    const pad = (4 - this.size % 4) % 4;
    if (pad) {
      this.parts.push(new Float32Array(pad));
      this.size += pad;
    }
    return off;
  }
  /** A tensor as stored. */
  w(name, shape) {
    return this.add(this.tensor(name, shape));
  }
  /** [batch][rows][cols] stored as [batch][cols][rows]. */
  t(name, shape, batch = 1) {
    const a = this.tensor(name, shape);
    const per = a.length / batch;
    const cols = shape[shape.length - 1];
    const rows = per / cols;
    const out = new Float32Array(a.length);
    for (let b = 0; b < batch; b++) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          out[b * per + c * rows + r] = a[b * per + r * cols + c];
        }
      }
    }
    return this.add(out);
  }
  build() {
    const out = new Float32Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
};
var Layout = class {
  size = 0;
  regions = {};
  alloc(name, n) {
    const off = this.size;
    this.regions[name] = [off, n];
    this.size += n + (4 - n % 4) % 4;
    return off;
  }
};
var u = (n) => `${n}u`;
function prelude(frame) {
  return `
@group(0) @binding(0) var<storage, read> W: array<f32>;
@group(0) @binding(1) var<storage, read_write> M: array<f32>;
@group(0) @binding(2) var<storage, read> W4: array<vec4f>;
fn frameNo() -> u32 { return u32(M[${u(frame)}]); }
fn slot(back: u32, cap: u32) -> u32 { return (frameNo() + ${u(FRAME_WRAP)} - back) % cap; }
fn sigm(x: f32) -> f32 { return 1.0 / (1.0 + exp(-x)); }
fn tanhf(x: f32) -> f32 { let e = exp(-2.0 * abs(x)); return sign(x) * (1.0 - e) / (1.0 + e); }
`;
}
function plan(src, init) {
  const wt = new Weights(src);
  const L = new Layout();
  const kernels = [];
  let nextId = 0;
  const id = () => `p${nextId++}`;
  const IN = L.alloc("in", SPEC);
  const FRAME = IN + SPEC;
  L.regions.frame = [FRAME, 1];
  const OUT = L.alloc("out", SPEC);
  const pre = prelude(FRAME);
  const dispatch = (name, size, ...parts) => {
    let code = pre;
    let main = "";
    let base = 0;
    for (const p of parts) {
      code += p.code;
      main += `  if (wg.x < ${u(base + p.groups)}) { ${p.id}(wg.x - ${u(base)}, l.x); return; }
`;
      base += p.groups;
    }
    code += `
@compute @workgroup_size(${size}) fn main(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) wg: vec3u) {
${main}}`;
    kernels.push({ name, code, groups: base });
  };
  const ERBMU = L.alloc("erbmu", DPDF_BINS2);
  const SPECS = L.alloc("specs", 96);
  const ERBBUF = L.alloc("erbbuf", 3 * DPDF_BINS2);
  const SPECBUF = L.alloc("specbuf", 3 * SPEC);
  const DFBUF = L.alloc("dfbuf", 3 * 192);
  const CPBUF = L.alloc("cpbuf", 5 * C * 96);
  const COEFBUF = L.alloc("coefbuf", 3 * 960);
  const DFS = L.alloc("dfs", 5 * SPEC);
  const E0 = L.alloc("e0", C * 480);
  const E1 = L.alloc("e1", C * 160);
  const E2 = L.alloc("e2", C * 80);
  const E3 = L.alloc("e3", C * 40);
  const C1 = L.alloc("c1", C * 48);
  const CP = L.alloc("cp", 10 * 96);
  const C0 = `(${u(CPBUF)} + slot(0u, 5u) * ${u(C * 96)})`;
  {
    const p = id();
    const c8 = wt.w("/model/erb_norm/Constant_8_output_0", [DPDF_BINS2]);
    dispatch("feat", 64, {
      id: p,
      groups: Math.ceil(DPDF_BINS2 / 64),
      code: `
fn ${p}(wid: u32, lid: u32) {
  let b = wid * 64u + lid;
  if (b >= ${u(DPDF_BINS2)}) { return; }
  let xr = M[${u(IN)} + 2u * b] * 0.0010416667;
  let xi = M[${u(IN)} + 2u * b + 1u] * 0.0010416667;
  let mag = sqrt(xr * xr + xi * xi);
  let db = log(mag + 1e-10) / 2.3025851 * 10.0;
  let mu = M[${u(ERBMU)} + b] * 0.98 + db * 0.02;
  M[${u(ERBMU)} + b] = mu;
  let s3 = slot(0u, 3u);
  M[${u(ERBBUF)} + s3 * ${u(DPDF_BINS2)} + b] = (db - mu) / W[${u(c8)} + b];
  M[${u(SPECBUF)} + (s3 * ${u(DPDF_BINS2)} + b) * 2u] = xr;
  M[${u(SPECBUF)} + (s3 * ${u(DPDF_BINS2)} + b) * 2u + 1u] = xi;
  if (b < 96u) {
    let s = M[${u(SPECS)} + b] * 0.98 + mag * 0.02;
    M[${u(SPECS)} + b] = s;
    let d = sqrt(s + 1e-12);
    M[${u(DFBUF)} + s3 * 192u + b] = xr / d;
    M[${u(DFBUF)} + s3 * 192u + 96u + b] = xi / d;
  }
}`
    });
  }
  const dwpw = (fout, dw, pw, bias, out, post = "0.0") => {
    const p = id();
    const pt = wt.t(pw, [C, C]);
    const b = wt.w(bias, [C]);
    return {
      id: p,
      groups: fout / 8,
      code: `
fn ${p}_dw(ci: u32, fo: u32) -> f32 {${dw}}
fn ${p}_post(co: u32, fo: u32) -> f32 { return ${post}; }
var<workgroup> ${p}_sh: array<f32, 512>;
fn ${p}(wid: u32, t: u32) {
  let f0 = wid * 8u;
  for (var j = 0u; j < 8u; j++) { ${p}_sh[t * 8u + j] = ${p}_dw(t, f0 + j); }
  workgroupBarrier();
  var acc: array<f32, 8>;
  let bias = W[${u(b)} + t];
  for (var j = 0u; j < 8u; j++) { acc[j] = bias; }
  for (var ci = 0u; ci < 64u; ci++) {
    let p = W[${u(pt)} + ci * 64u + t];
    for (var j = 0u; j < 8u; j++) { acc[j] += p * ${p}_sh[ci * 8u + j]; }
  }
  for (var j = 0u; j < 8u; j++) { M[${out("t", "(f0 + j)")}] = max(acc[j], 0.0) + ${p}_post(t, f0 + j); }
}`
    };
  };
  const strided = (weight, src2, fin, stride) => {
    const w = wt.w(weight, [C, 1, 1, 3]);
    return `
  var acc = 0.0;
  for (var k = 0u; k < 3u; k++) {
    let fi = i32(fo * ${u(stride)} + k) - 1;
    if (fi >= 0 && fi < ${fin}) { acc += W[${u(w)} + ci * 3u + k] * M[${src2} + ci * ${u(fin)} + u32(fi)]; }
  }
  return acc;`;
  };
  {
    const p = id();
    const w = wt.w("onnx::Conv_2114", [C, 1, 3, 3]);
    const b = wt.w("onnx::Conv_2115", [C]);
    const erb = {
      id: p,
      groups: C * 480 / 64,
      code: `
fn ${p}(wid: u32, lid: u32) {
  let i = wid * 64u + lid;
  let c = i / 480u;
  let f = i % 480u;
  var acc = W[${u(b)} + c];
  for (var kt = 0u; kt < 3u; kt++) {
    let row = ${u(ERBBUF)} + slot(2u - kt, 3u) * ${u(DPDF_BINS2)};
    for (var kf = 0u; kf < 3u; kf++) {
      let ff = i32(f) + i32(kf) - 1;
      if (ff >= 0 && ff < 480) { acc += W[${u(w)} + c * 9u + kt * 3u + kf] * M[row + u32(ff)]; }
    }
  }
  M[${u(E0)} + c * 480u + f] = max(acc, 0.0);
}`
    };
    const w0 = wt.w("model.enc.df_conv0.1.convs.0.weight", [32, 1, 3, 3]);
    const w1 = wt.w("model.enc.df_conv0.1.convs.1.weight", [32, 1, 3, 3]);
    const df = dwpw(
      96,
      `
  let grp = ci / 32u;
  let wb = select(${u(w0)}, ${u(w1)}, grp == 1u) + (ci % 32u) * 9u;
  var acc = 0.0;
  for (var kt = 0u; kt < 3u; kt++) {
    let row = ${u(DFBUF)} + slot(2u - kt, 3u) * 192u + grp * 96u;
    for (var kf = 0u; kf < 3u; kf++) {
      let fi = i32(fo + kf) - 1;
      if (fi >= 0 && fi < 96) { acc += W[wb + kt * 3u + kf] * M[row + u32(fi)]; }
    }
  }
  return acc;`,
      "onnx::Conv_2126",
      "onnx::Conv_2127",
      (co, fo) => `${C0} + ${co} * 96u + ${fo}`
    );
    dispatch("conv0", 64, erb, df);
  }
  dispatch(
    "conv1",
    64,
    dwpw(
      160,
      strided("model.enc.erb_conv1.0.weight", u(E0), 480, 3),
      "onnx::Conv_2117",
      "onnx::Conv_2118",
      (co, fo) => `${u(E1)} + ${co} * 160u + ${fo}`
    ),
    dwpw(
      48,
      strided("model.enc.df_conv1.0.weight", C0, 96, 2),
      "onnx::Conv_2129",
      "onnx::Conv_2130",
      (co, fo) => `${u(C1)} + ${co} * 48u + ${fo}`
    )
  );
  {
    const p = id();
    const w0 = wt.w(
      "model.df_dec.df_convp.1.convs.0.weight",
      [5, 32, 5, 1]
    );
    const w1 = wt.w(
      "model.df_dec.df_convp.1.convs.1.weight",
      [5, 32, 5, 1]
    );
    const pw = wt.w("onnx::Conv_2156", [10, 10]);
    const b = wt.w("onnx::Conv_2157", [10]);
    dispatch("df_convp", 80, {
      id: p,
      groups: 12,
      code: `
var<workgroup> ${p}_pre: array<f32, 80>;
fn ${p}(wid: u32, lid: u32) {
  let fl = lid % 8u;
  let ch = lid / 8u;
  let f = wid * 8u + fl;
  let grp = ch / 5u;
  let wb = select(${u(w0)}, ${u(w1)}, grp == 1u) + (ch % 5u) * 160u;
  var acc = 0.0;
  for (var kt = 0u; kt < 5u; kt++) {
    let row = ${u(CPBUF)} + slot(4u - kt, 5u) * ${u(C * 96)} + grp * ${u(32 * 96)} + f;
    for (var ci = 0u; ci < 32u; ci++) { acc += W[wb + ci * 5u + kt] * M[row + ci * 96u]; }
  }
  ${p}_pre[ch * 8u + fl] = acc;
  workgroupBarrier();
  var o = W[${u(b)} + ch];
  for (var k = 0u; k < 10u; k++) { o += W[${u(pw)} + ch * 10u + k] * ${p}_pre[k * 8u + fl]; }
  M[${u(CP)} + ch * 96u + f] = max(o, 0.0);
}`
    });
  }
  dispatch(
    "erb_conv2",
    64,
    dwpw(
      80,
      strided("model.enc.erb_conv2.0.weight", u(E1), 160, 2),
      "onnx::Conv_2120",
      "onnx::Conv_2121",
      (co, fo) => `${u(E2)} + ${co} * 80u + ${fo}`
    )
  );
  dispatch(
    "erb_conv3",
    64,
    dwpw(
      40,
      strided("model.enc.erb_conv3.0.weight", u(E2), 80, 2),
      "onnx::Conv_2123",
      "onnx::Conv_2124",
      (co, fo) => `${u(E3)} + ${co} * 40u + ${fo}`
    )
  );
  const fcLn = (F, K, wT, bias, gamma, beta, src2, res, dst) => {
    const p = id();
    return {
      id: p,
      groups: F,
      code: `
var<workgroup> ${p}_red: array<f32, 64>;
fn ${p}_total(c: u32, v: f32) -> f32 {
  ${p}_red[c] = v;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (c < s) { ${p}_red[c] += ${p}_red[c + s]; }
    workgroupBarrier();
  }
  let r = ${p}_red[0];
  workgroupBarrier();
  return r;
}
fn ${p}(f: u32, c: u32) {
  let srcBase = ${u(src2)} + f * ${u(K)};
  var y = W[${u(bias)} + c];
  for (var k = 0u; k < ${u(K)}; k++) { y += W[${u(wT)} + k * 64u + c] * M[srcBase + k]; }
  let mean = ${p}_total(c, y) / 64.0;
  let d = y - mean;
  let v = ${p}_total(c, d * d) / 64.0;
  let n = d / sqrt(v + 1e-5) * W[${u(gamma)} + c] + W[${u(beta)} + c];
  M[${u(dst)} + c * ${u(F)} + f] = M[${u(res)} + c * ${u(F)} + f] + n;
}`
    };
  };
  const H0 = wt.w(
    "/model/enc/dprnn_erb/blocks.0/intra_gru/Expand_output_0",
    [2, 64]
  );
  const block = (path, blk, F, x, ids) => {
    const pfx = `model.enc.dprnn_${path}.blocks.${blk}`;
    const [Wn, Rn, Bn, fcn] = ids;
    const GI = L.alloc(`${path}${blk}_gi`, F * 384);
    const OI = L.alloc(`${path}${blk}_oi`, F * 128);
    const MID = L.alloc(`${path}${blk}_mid`, C * F);
    const HST = L.alloc(`${path}${blk}_h`, 2 * F * C);
    const HN = L.alloc(`${path}${blk}_hn`, F * C);
    const OUTB = L.alloc(`${path}${blk}_out`, C * F);
    const Wt = wt.t(Wn, [2, 192, 64], 2);
    const R = wt.w(Rn, [2, 192, 64]);
    const B = wt.w(Bn, [2, 384]);
    const pih = id();
    const prec = id();
    const pint = id();
    const ih = {
      id: pih,
      groups: F * 384 / 64,
      code: `
fn ${pih}(wid: u32, lid: u32) {
  let i = wid * 64u + lid;
  let f = i / 384u;
  let r = i % 384u;
  let d = r / 192u;
  let g = r % 192u;
  var acc = W[${u(B)} + d * 384u + g];
  let wb = ${u(Wt)} + d * 12288u + g;
  for (var c = 0u; c < 64u; c++) { acc += W[wb + c * 192u] * M[${u(x)} + c * ${u(F)} + f]; }
  M[${u(GI)} + f * 384u + r] = acc;
}`
    };
    const k16 = Array.from({ length: 16 }, (_, k) => k);
    const rec = {
      id: prec,
      groups: 2,
      code: `
var<workgroup> ${prec}_h: array<vec4f, 16>;
var<workgroup> ${prec}_g: array<f32, 192>;
fn ${prec}(d: u32, row: u32) {
  if (row < 64u) { ${prec}_h[row / 4u][row % 4u] = W[${u(H0)} + d * 64u + row]; }
  let rb = ${u(R / 4)} + (d * 192u + row) * 16u;
  ${k16.map((k) => `let w${k} = W4[rb + ${u(k)}];`).join("\n  ")}
  let bias = W[${u(B)} + d * 384u + 192u + row];
  workgroupBarrier();
  for (var s = 0u; s < ${u(F)}; s++) {
    let f = select(${u(F - 1)} - s, s, d == 0u);
    let gi = ${u(GI)} + f * 384u + d * 192u + row;
    var xz = 0.0;
    var xr = 0.0;
    var xh = 0.0;
    if (row < 64u) {
      xz = M[gi];
      xr = M[gi + 64u];
      xh = M[gi + 128u];
    }
    ${[0, 1, 2, 3].map((q) => `let a${q} = ${[0, 1, 2, 3].map((j) => `dot(w${q * 4 + j}, ${prec}_h[${u(q * 4 + j)}])`).join(" + ")};`).join("\n    ")}
    ${prec}_g[row] = bias + (a0 + a1) + (a2 + a3);
    workgroupBarrier();
    if (row < 64u) {
      let z = sigm(xz + ${prec}_g[row]);
      let r = sigm(xr + ${prec}_g[row + 64u]);
      let n = tanhf(xh + r * ${prec}_g[row + 128u]);
      let h = (1.0 - z) * n + z * ${prec}_h[row / 4u][row % 4u];
      ${prec}_h[row / 4u][row % 4u] = h;
      M[${u(OI)} + f * 128u + d * 64u + row] = h;
    }
    workgroupBarrier();
  }
}`
    };
    const fcIntra = fcLn(
      F,
      128,
      wt.w(fcn, [128, 64]),
      wt.w(`${pfx}.fc_intra.bias`, [C]),
      wt.w(`${pfx}.ln_intra.weight`, [C]),
      wt.w(`${pfx}.ln_intra.bias`, [C]),
      OI,
      x,
      MID
    );
    const Wih = wt.t(`${pfx}.inter_gru.grucell.weight_ih`, [192, 64]);
    const Whh = wt.t(`${pfx}.inter_gru.grucell.weight_hh`, [192, 64]);
    const bih = wt.w(`${pfx}.inter_gru.grucell.bias_ih`, [192]);
    const bhh = wt.w(`${pfx}.inter_gru.grucell.bias_hh`, [192]);
    const inter = {
      id: pint,
      groups: F,
      code: `
fn ${pint}(f: u32, un: u32) {
  let par = frameNo() % 2u;
  let hsrc = ${u(HST)} + par * ${u(F * C)} + f * 64u;
  var ir = W[${u(bih)} + un];
  var iz = W[${u(bih)} + 64u + un];
  var inn = W[${u(bih)} + 128u + un];
  var hr = W[${u(bhh)} + un];
  var hz = W[${u(bhh)} + 64u + un];
  var hh = W[${u(bhh)} + 128u + un];
  for (var k = 0u; k < 64u; k++) {
    let xk = M[${u(MID)} + k * ${u(F)} + f];
    let hk = M[hsrc + k];
    let wi = ${u(Wih)} + k * 192u + un;
    let wh = ${u(Whh)} + k * 192u + un;
    ir += W[wi] * xk;
    iz += W[wi + 64u] * xk;
    inn += W[wi + 128u] * xk;
    hr += W[wh] * hk;
    hz += W[wh + 64u] * hk;
    hh += W[wh + 128u] * hk;
  }
  let r = sigm(ir + hr);
  let z = sigm(iz + hz);
  let n = tanhf(inn + r * hh);
  let h = (1.0 - z) * n + z * M[hsrc + un];
  M[${u(HST)} + (1u - par) * ${u(F * C)} + f * 64u + un] = h;
  M[${u(HN)} + f * 64u + un] = h;
}`
    };
    const fcInter = fcLn(
      F,
      64,
      wt.t(`${pfx}.fc_inter.weight`, [64, 64]),
      wt.w(`${pfx}.fc_inter.bias`, [C]),
      wt.w(`${pfx}.ln_inter.weight`, [C]),
      wt.w(`${pfx}.ln_inter.bias`, [C]),
      HN,
      MID,
      OUTB
    );
    return { ih, rec, fcIntra, inter, fcInter, out: OUTB };
  };
  const GRU_IDS = {
    erb: [
      [
        "onnx::GRU_2231",
        "onnx::GRU_2232",
        "onnx::GRU_2230",
        "onnx::MatMul_2234"
      ],
      [
        "onnx::GRU_2297",
        "onnx::GRU_2298",
        "onnx::GRU_2296",
        "onnx::MatMul_2300"
      ]
    ],
    df: [
      [
        "onnx::GRU_2375",
        "onnx::GRU_2376",
        "onnx::GRU_2374",
        "onnx::MatMul_2378"
      ],
      [
        "onnx::GRU_2441",
        "onnx::GRU_2442",
        "onnx::GRU_2440",
        "onnx::MatMul_2444"
      ]
    ]
  };
  let XE = E3;
  let XD = C1;
  for (let blk = 0; blk < 2; blk++) {
    const e = block("erb", blk, 40, XE, GRU_IDS.erb[blk]);
    const d = block("df", blk, 48, XD, GRU_IDS.df[blk]);
    dispatch(`dprnn${blk}_ih`, 64, e.ih, d.ih);
    dispatch(`dprnn${blk}_rec`, 192, e.rec, d.rec);
    dispatch(`dprnn${blk}_fc_intra`, 64, e.fcIntra, d.fcIntra);
    dispatch(`dprnn${blk}_inter`, 64, e.inter, d.inter);
    dispatch(`dprnn${blk}_fc_inter`, 64, e.fcInter, d.fcInter);
    XE = e.out;
    XD = d.out;
  }
  const glin = (weight, bias, G, Ig, Hg, inp, act, out, add = () => "0.0") => {
    const p = id();
    const w = wt.w(weight, [G, Ig, Hg]);
    const b = wt.w(bias, [G * Hg]);
    const N = G * Hg;
    const a = act === "relu" ? "max(acc, 0.0)" : act === "tanh" ? "tanhf(acc)" : "acc";
    return {
      id: p,
      groups: Math.ceil(N / 64),
      code: `
fn ${p}(wid: u32, lid: u32) {
  let o = wid * 64u + lid;
  if (o >= ${u(N)}) { return; }
  let grp = o / ${u(Hg)};
  let j = o % ${u(Hg)};
  var acc = W[${u(b)} + o];
  let wb = ${u(w)} + grp * ${u(Ig * Hg)} + j;
  let ib = grp * ${u(Ig)};
  for (var k = 0u; k < ${u(Ig)}; k++) { acc += W[wb + k * ${u(Hg)}] * ${inp("(ib + k)")}; }
  M[${out("o")}] = ${a} + ${add("o")};
}`
    };
  };
  const gru256 = (name, pfx, xin, xout) => {
    const p = id();
    const H = L.alloc(`${name}_h`, 2 * 256);
    const Wi = wt.w(`${pfx}.weight_ih`, [768, 256]);
    const Wh = wt.w(`${pfx}.weight_hh`, [768, 256]);
    const bi = wt.w(`${pfx}.bias_ih`, [768]);
    const bh = wt.w(`${pfx}.bias_hh`, [768]);
    return {
      id: p,
      groups: 64,
      code: `
var<workgroup> ${p}_part: array<f32, 384>;
fn ${p}(wid: u32, lane: u32) {
  let uu = lane / 16u;
  let sp = lane % 16u;
  let un = wid * 4u + uu;
  let par = frameNo() % 2u;
  let hsrc = ${u(H)} + par * 256u;
  let xb = ${u(xin)} + sp * 16u;
  let hb = hsrc + sp * 16u;
  ${[0, 1, 2, 3].map(
        (i) => `let x${i} = vec4f(M[xb + ${u(4 * i)}], M[xb + ${u(4 * i + 1)}], M[xb + ${u(4 * i + 2)}], M[xb + ${u(4 * i + 3)}]);
  let h${i} = vec4f(M[hb + ${u(4 * i)}], M[hb + ${u(4 * i + 1)}], M[hb + ${u(4 * i + 2)}], M[hb + ${u(4 * i + 3)}]);`
      ).join("\n  ")}
  let wi = ${u(Wi / 4)} + un * 64u + sp * 4u;
  let wh = ${u(Wh / 4)} + un * 64u + sp * 4u;
  ${[0, 1, 2].map(
        (q) => `${p}_part[lane * 6u + ${u(q)}] = ${[0, 1, 2, 3].map((i) => `dot(W4[wi + ${u(q * 256 * 64 + i)}], x${i})`).join(" + ")};
  ${p}_part[lane * 6u + ${u(q + 3)}] = ${[0, 1, 2, 3].map((i) => `dot(W4[wh + ${u(q * 256 * 64 + i)}], h${i})`).join(" + ")};`
      ).join("\n  ")}
  workgroupBarrier();
  if (sp == 0u) {
    var s: array<f32, 6>;
    for (var j = 0u; j < 16u; j++) {
      for (var q = 0u; q < 6u; q++) { s[q] += ${p}_part[(uu * 16u + j) * 6u + q]; }
    }
    let r = sigm(s[0] + W[${u(bi)} + un] + s[3] + W[${u(bh)} + un]);
    let z = sigm(s[1] + W[${u(bi)} + 256u + un] + s[4] + W[${u(bh)} + 256u + un]);
    let n = tanhf(s[2] + W[${u(bi)} + 512u + un] + r * (s[5] + W[${u(bh)} + 512u + un]));
    let h = (1.0 - z) * n + z * M[hsrc + un];
    M[${u(H)} + (1u - par) * 256u + un] = h;
    M[${u(xout)} + un] = h;
  }
}`
    };
  };
  const EMBIN = L.alloc("emb_in", 1024);
  const LIN = L.alloc("enc_lin", 256);
  const GENC = L.alloc("enc_gru", 256);
  const EMB = L.alloc("emb", 512);
  const at = (base) => (i) => `M[${u(base)} + ${i}]`;
  const to = (base) => (o) => `${u(base)} + ${o}`;
  dispatch(
    "fc_emb",
    64,
    glin(
      "model.enc.erb_fc_emb.0.weight",
      "model.enc.erb_fc_emb.0.bias",
      32,
      80,
      16,
      (i) => `M[${u(XE)} + (${i} % 64u) * 40u + ${i} / 64u]`,
      "relu",
      to(EMBIN)
    ),
    glin(
      "model.enc.df_fc_emb.0.weight",
      "model.enc.df_fc_emb.0.bias",
      32,
      96,
      16,
      (i) => `M[${u(XD)} + (${i} % 64u) * 48u + ${i} / 64u]`,
      "relu",
      to(EMBIN + 512)
    )
  );
  dispatch(
    "enc_lin_in",
    64,
    glin(
      "model.enc.emb_gru.linear_in.0.weight",
      "model.enc.emb_gru.linear_in.0.bias",
      16,
      64,
      16,
      at(EMBIN),
      "relu",
      to(LIN)
    )
  );
  dispatch(
    "enc_gru",
    64,
    gru256("enc_gru", "model.enc.emb_gru.gru.0.grucell", LIN, GENC)
  );
  dispatch(
    "enc_lin_out",
    64,
    glin(
      "model.enc.emb_gru.linear_out.0.weight",
      "model.enc.emb_gru.linear_out.0.bias",
      16,
      16,
      32,
      at(GENC),
      "relu",
      to(EMB)
    )
  );
  const EDIN = L.alloc("ed_lin", 256);
  const EDG0 = L.alloc("ed_gru0", 256);
  const EDG1 = L.alloc("ed_gru1", 256);
  const EDOUT = L.alloc("ed_out", 512);
  const EDFC = L.alloc("ed_fc", 2560);
  const DDIN = L.alloc("dd_lin", 256);
  const DDG0 = L.alloc("dd_gru0", 256);
  const DDG1 = L.alloc("dd_gru1", 256);
  const DDC = L.alloc("dd_c", 256);
  dispatch(
    "dec_lin_in",
    64,
    glin(
      "model.erb_dec.emb_gru.linear_in.0.weight",
      "model.erb_dec.emb_gru.linear_in.0.bias",
      16,
      32,
      16,
      at(EMB),
      "relu",
      to(EDIN)
    ),
    glin(
      "model.df_dec.df_gru.linear_in.0.weight",
      "model.df_dec.df_gru.linear_in.0.bias",
      8,
      64,
      32,
      at(EMB),
      "relu",
      to(DDIN)
    )
  );
  dispatch(
    "dec_gru0",
    64,
    gru256("ed_gru0", "model.erb_dec.emb_gru.gru.0.grucell", EDIN, EDG0),
    gru256("dd_gru0", "model.df_dec.df_gru.gru.0.grucell", DDIN, DDG0)
  );
  dispatch(
    "dec_gru1",
    64,
    gru256("ed_gru1", "model.erb_dec.emb_gru.gru.1.grucell", EDG0, EDG1),
    gru256("dd_gru1", "model.df_dec.df_gru.gru.1.grucell", DDG0, DDG1)
  );
  dispatch(
    "dec_lin_out",
    64,
    glin(
      "model.erb_dec.emb_gru.linear_out.0.weight",
      "model.erb_dec.emb_gru.linear_out.0.bias",
      16,
      16,
      32,
      at(EDG1),
      "relu",
      to(EDOUT)
    ),
    // The DF decoder's skip from the embedding, added to its GRU output.
    glin(
      "model.df_dec.df_skip.weight",
      "model.df_dec.df_skip.bias",
      16,
      32,
      16,
      at(EMB),
      "none",
      to(DDC),
      (o) => `M[${u(DDG1)} + ${o}]`
    )
  );
  dispatch(
    "dec_fc",
    64,
    glin(
      "model.erb_dec.erb_fc_emb.0.weight",
      "model.erb_dec.erb_fc_emb.0.bias",
      32,
      16,
      80,
      at(EDOUT),
      "relu",
      to(EDFC)
    ),
    // Deep-filter coefficients for this frame (bin-major, 5 frames x
    // re/im), plus the pathway conv, into the coefficient ring.
    glin(
      "model.df_dec.df_out.0.weight",
      "model.df_dec.df_out.0.bias",
      16,
      16,
      60,
      at(DDC),
      "tanh",
      (o) => `${u(COEFBUF)} + slot(0u, 3u) * 960u + ${o}`,
      (o) => `M[${u(CP)} + (${o} % 10u) * 96u + ${o} / 10u]`
    )
  );
  const subpix = (name, fin, s, skip, pa, pb, prev, convs, pw, bias, out, post) => {
    const a = wt.w(pa, [C]);
    const b = wt.w(pb, [C]);
    const ws = Array.from(
      { length: s },
      (_, j) => wt.w(`${convs}.${j}.weight`, [C, 1, 1, 3])
    );
    const xin = (ci, f) => `(max(W[${u(a)} + ${ci}] * M[${u(skip)} + ${ci} * ${u(fin)} + ${f}] + W[${u(b)} + ${ci}], 0.0) + ${prev(ci, f)})`;
    dispatch(
      name,
      64,
      dwpw(
        fin * s,
        `
  let f = fo / ${u(s)};
  let j = fo % ${u(s)};
  var wb = ${u(ws[0])};
  ${ws.slice(1).map((o, j) => `if (j == ${u(j + 1)}) { wb = ${u(o)}; }`).join("\n  ")}
  var acc = 0.0;
  for (var k = 0u; k < 3u; k++) {
    let fi = i32(f + k) - 1;
    if (fi >= 0 && fi < ${fin}) { acc += W[wb + ci * 3u + k] * ${xin("ci", "u32(fi)")}; }
  }
  return acc;`,
        pw,
        bias,
        (co, fo) => `${u(out)} + ${co} * ${u(fin * s)} + ${fo}`,
        post
      )
    );
  };
  const D3 = L.alloc("d3", C * 80);
  const D2 = L.alloc("d2", C * 160);
  const A0 = L.alloc("a0", C * 480);
  subpix(
    "convt3",
    40,
    2,
    E3,
    "onnx::Conv_2132",
    "onnx::Conv_2133",
    (ci, f) => `M[${u(EDFC)} + ${f} * 64u + ${ci}]`,
    "model.erb_dec.convt3.0.convs",
    "onnx::Conv_2135",
    "onnx::Conv_2136",
    D3
  );
  subpix(
    "convt2",
    80,
    2,
    E2,
    "onnx::Conv_2138",
    "onnx::Conv_2139",
    (ci, f) => `M[${u(D3)} + ${ci} * 80u + ${f}]`,
    "model.erb_dec.convt2.0.convs",
    "onnx::Conv_2141",
    "onnx::Conv_2142",
    D2
  );
  {
    const pa = wt.w("onnx::Conv_2150", [C]);
    const pb = wt.w("onnx::Conv_2151", [C]);
    subpix(
      "convt1",
      160,
      3,
      E1,
      "onnx::Conv_2144",
      "onnx::Conv_2145",
      (ci, f) => `M[${u(D2)} + ${ci} * 160u + ${f}]`,
      "model.erb_dec.convt1.0.convs",
      "onnx::Conv_2147",
      "onnx::Conv_2148",
      A0,
      `max(W[${u(pa)} + co] * M[${u(E0)} + co * 480u + fo] + W[${u(pb)} + co], 0.0)`
    );
  }
  {
    const p = id();
    const wm = wt.w("onnx::Conv_2153", [C, 3]);
    const bm = wt.w("onnx::Conv_2154", [1]);
    dispatch("mask_df", 64, {
      id: p,
      groups: Math.ceil(DPDF_BINS2 / 8),
      code: `
var<workgroup> ${p}_red: array<f32, 512>;
fn ${p}(wid: u32, c: u32) {
  let b0 = wid * 8u;
  for (var j = 0u; j < 8u; j++) {
    let b = min(b0 + j, 480u);
    let fm = select(b, 478u, b == 480u);
    var acc = 0.0;
    for (var k = 0u; k < 3u; k++) {
      let ff = i32(fm + k) - 1;
      if (ff >= 0 && ff < 480) { acc += W[${u(wm)} + c * 3u + k] * M[${u(A0)} + c * 480u + u32(ff)]; }
    }
    ${p}_red[j * 64u + c] = acc;
  }
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (c < s) {
      for (var j = 0u; j < 8u; j++) { ${p}_red[j * 64u + c] += ${p}_red[j * 64u + c + s]; }
    }
    workgroupBarrier();
  }
  let b = b0 + c;
  if (c >= 8u || b >= ${u(DPDF_BINS2)}) { return; }
  let m = sigm(${p}_red[c * 64u] + W[${u(bm)}]);
  let sp = ${u(SPECBUF)} + (slot(2u, 3u) * ${u(DPDF_BINS2)} + b) * 2u;
  let d0 = ${u(DFS)} + (slot(0u, 5u) * ${u(DPDF_BINS2)} + b) * 2u;
  M[d0] = M[sp] * m;
  M[d0 + 1u] = M[sp + 1u] * m;
  var re = 0.0;
  var im = 0.0;
  if (b < 96u) {
    let cb = ${u(COEFBUF)} + slot(2u, 3u) * 960u + b * 10u;
    for (var o = 0u; o < 5u; o++) {
      let so = ${u(DFS)} + (slot(4u - o, 5u) * ${u(DPDF_BINS2)} + b) * 2u;
      let xr = M[so];
      let xi = M[so + 1u];
      let cr = M[cb + o * 2u];
      let ci = M[cb + o * 2u + 1u];
      re += xr * cr - xi * ci;
      im += xr * ci + xi * cr;
    }
  } else {
    let so = ${u(DFS)} + (slot(2u, 5u) * ${u(DPDF_BINS2)} + b) * 2u;
    re = M[so];
    im = M[so + 1u];
  }
  M[${u(OUT)} + 2u * b] = re * 960.0;
  M[${u(OUT)} + 2u * b + 1u] = im * 960.0;
}`
    });
  }
  const memInit = new Float32Array(L.size);
  memInit.set(init.erbNormInit, ERBMU);
  memInit.set(init.specNormInit, SPECS);
  return {
    kernels,
    weights: wt.build(),
    memSize: L.size,
    memInit,
    regions: L.regions,
    io: { input: IN, frame: FRAME, output: OUT }
  };
}
var GpuModel = class _GpuModel {
  constructor(device, plan2, pipelines, layout, weights) {
    this.device = device;
    this.plan = plan2;
    this.pipelines = pipelines;
    this.layout = layout;
    this.weights = weights;
  }
  static async create(device, p) {
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" }
        }
      ]
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layout]
    });
    device.pushErrorScope("validation");
    const pipelines = await Promise.all(
      p.kernels.map(
        (k) => device.createComputePipelineAsync({
          label: k.name,
          layout: pipelineLayout,
          compute: {
            module: device.createShaderModule({
              label: k.name,
              code: k.code
            }),
            entryPoint: "main"
          }
        })
      )
    );
    const weights = device.createBuffer({
      size: p.weights.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(weights, 0, p.weights);
    const err = await device.popErrorScope();
    if (err) {
      weights.destroy();
      throw new Error(`WebGPU: ${err.message}`);
    }
    return new _GpuModel(device, p, pipelines, layout, weights);
  }
  session() {
    return new DpdfnetSession(this);
  }
  destroy() {
    this.weights.destroy();
  }
};
var DpdfnetSession = class {
  constructor(model2) {
    this.model = model2;
    const { device, plan: plan2 } = model2;
    this.mem = device.createBuffer({
      size: plan2.memSize * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
    device.queue.writeBuffer(this.mem, 0, plan2.memInit);
    this.bindGroup = device.createBindGroup({
      layout: model2.layout,
      entries: [
        { binding: 0, resource: { buffer: model2.weights } },
        { binding: 1, resource: { buffer: this.mem } },
        { binding: 2, resource: { buffer: model2.weights } }
      ]
    });
  }
  frame = 0;
  free = [];
  upload = new Float32Array(SPEC + 1);
  bindGroup;
  mem;
  /** Back to the model's initial state (in line with frames already sent). */
  reset() {
    this.model.device.queue.writeBuffer(
      this.mem,
      0,
      this.model.plan.memInit
    );
    this.frame = 0;
  }
  /** Records one frame's work; `pass` lets a caller time it. */
  encode(enc, pass) {
    const cp = enc.beginComputePass(pass);
    cp.setBindGroup(0, this.bindGroup);
    const k = this.model.plan.kernels;
    for (let i = 0; i < k.length; i++) {
      cp.setPipeline(this.model.pipelines[i]);
      cp.dispatchWorkgroups(k[i].groups);
    }
    cp.end();
  }
  /** Writes a frame and returns an encoder holding its work, not yet
   *  submitted; a caller can add to it. */
  submit(spec) {
    this.upload.set(spec);
    this.upload[SPEC] = this.frame;
    this.frame = (this.frame + 1) % FRAME_WRAP;
    const { device, plan: plan2 } = this.model;
    device.queue.writeBuffer(this.mem, plan2.io.input * 4, this.upload);
    const enc = device.createCommandEncoder();
    this.encode(enc);
    return enc;
  }
  process(spec) {
    const { device, plan: plan2 } = this.model;
    const buf = this.free.pop() ?? device.createBuffer({
      size: SPEC * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const enc = this.submit(spec);
    enc.copyBufferToBuffer(this.mem, plan2.io.output * 4, buf, 0, SPEC * 4);
    device.queue.submit([enc.finish()]);
    return buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const out = new Float32Array(buf.getMappedRange().slice(0));
        buf.unmap();
        if (this.free.length < STAGING) this.free.push(buf);
        else buf.destroy();
        return out;
      },
      (err) => {
        buf.destroy();
        throw err;
      }
    );
  }
  /** The whole mutable buffer (debugging). */
  async readMem() {
    const { device, plan: plan2 } = this.model;
    const buf = device.createBuffer({
      size: plan2.memSize * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(this.mem, 0, buf, 0, plan2.memSize * 4);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(buf.getMappedRange().slice(0));
    buf.destroy();
    return out;
  }
  destroy() {
    for (const b of this.free) b.destroy();
    this.free.length = 0;
    this.mem.destroy();
  }
};

// src/dpdfnet/src/webgpu/onnx.ts
var FLOAT = 1;
var Reader = class _Reader {
  constructor(buf, pos, end) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }
  varint() {
    let r = 0;
    let mul = 1;
    let b;
    do {
      if (this.pos >= this.end) throw new Error("truncated varint");
      b = this.buf[this.pos++];
      r += (b & 127) * mul;
      mul *= 128;
    } while (b & 128);
    return r;
  }
  /** Field number and wire type of the next key. */
  key() {
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }
  /** A length-delimited field's bounds. */
  sub() {
    const len = this.varint();
    const start2 = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error("truncated field");
    return new _Reader(this.buf, start2, this.pos);
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.sub();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
};
function readTensor(r) {
  let name = "";
  let type = 0;
  const dims = [];
  let raw = null;
  const floats = [];
  while (r.pos < r.end) {
    const [field, wire] = r.key();
    if (field === 1 && wire === 0) dims.push(r.varint());
    else if (field === 1 && wire === 2) {
      const p = r.sub();
      while (p.pos < p.end) dims.push(p.varint());
    } else if (field === 2 && wire === 0) type = r.varint();
    else if (field === 4 && wire === 2) {
      const p = r.sub();
      const v = new DataView(
        p.buf.buffer,
        p.buf.byteOffset + p.pos,
        p.end - p.pos
      );
      for (let i = 0; i + 4 <= v.byteLength; i += 4)
        floats.push(v.getFloat32(i, true));
    } else if (field === 4 && wire === 5) {
      floats.push(
        new DataView(
          r.buf.buffer,
          r.buf.byteOffset + r.pos,
          4
        ).getFloat32(0, true)
      );
      r.pos += 4;
    } else if (field === 8 && wire === 2) {
      const p = r.sub();
      name = new TextDecoder().decode(p.buf.subarray(p.pos, p.end));
    } else if (field === 9 && wire === 2) {
      const p = r.sub();
      raw = p.buf.subarray(p.pos, p.end);
    } else if (field === 14 && wire === 0) {
      if (r.varint() === 1) throw new Error(`${name}: external data`);
    } else r.skip(wire);
  }
  if (type !== FLOAT) return null;
  let data;
  if (raw) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    data = new Float32Array(raw.byteLength / 4);
    for (let i = 0; i < data.length; i++)
      data[i] = dv.getFloat32(i * 4, true);
  } else data = Float32Array.from(floats);
  return [name, { dims, data }];
}
function readInitializers(model2) {
  const buf = model2 instanceof Uint8Array ? model2 : new Uint8Array(model2);
  const out = /* @__PURE__ */ new Map();
  const top = new Reader(buf, 0, buf.length);
  while (top.pos < top.end) {
    const [field, wire] = top.key();
    if (field !== 7 || wire !== 2) {
      top.skip(wire);
      continue;
    }
    const graph = top.sub();
    while (graph.pos < graph.end) {
      const [gf, gw] = graph.key();
      if (gf === 5 && gw === 2) {
        const t = readTensor(graph.sub());
        if (t) out.set(t[0], t[1]);
      } else graph.skip(gw);
    }
  }
  return out;
}

// src/dpdfnet/src/webgpu/selftest.js
var SELFTEST_FRAMES = 32;
var SELFTEST_CHECK = 8;
var SELFTEST_MIN_SNR_DB = 60;
var BINS = 481;
function selftestFrame(t) {
  let seed = t * 7919 + 1234 >>> 0;
  const rand = () => {
    seed = Math.imul(seed, 1103515245) + 12345 >>> 0;
    return seed / 4294967296;
  };
  const out = new Float32Array(BINS * 2);
  const voiced = t % 16 < 11;
  const f0Bins = (130 + 40 * Math.sin(t / 5)) / 50;
  for (let k = 0; k < BINS; k++) {
    let amp = 0.2 * (0.5 + rand());
    if (voiced) {
      const h = Math.round(k / f0Bins);
      if (h >= 1 && Math.abs(k - h * f0Bins) < 0.75) amp += 30 / h;
    }
    const phase = rand() * 2 * Math.PI;
    out[2 * k] = amp * Math.cos(phase);
    out[2 * k + 1] = amp * Math.sin(phase);
  }
  return out;
}
function snrDb(want, got) {
  let s = 0;
  let e = 0;
  for (let i = 0; i < want.length; i++) {
    s += want[i] * want[i];
    e += (got[i] - want[i]) ** 2;
  }
  if (!(e === e) || !(s === s)) return -Infinity;
  return 10 * Math.log10(s / Math.max(e, 1e-30));
}

// src/dpdfnet/src/worker.ts
var SPEC_SHAPE = [1, 1, DPDF_BINS, 2];
var errorText = (err) => err instanceof Error ? err.message : String(err);
var SPEC2 = DPDF_BINS * 2;
var model = null;
var engines = /* @__PURE__ */ new Map();
async function wasmEngine(m) {
  if (!model) throw new Error("no model");
  const ort = await import(
    /* @vite-ignore */
    m.ortModuleUrl
  );
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = m.ortWasm;
  ort.env.wasm.wasmPaths = { mjs: m.ortGlueUrl };
  const sess = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  });
  return {
    name: "worker",
    session() {
      let state = freshState(MODEL_INIT);
      let queue = Promise.resolve();
      return {
        process(spec) {
          const run = queue.then(async () => {
            const out = await sess.run({
              spec: new ort.Tensor("float32", spec, SPEC_SHAPE),
              state_in: new ort.Tensor("float32", state, [
                state.length
              ])
            });
            state = out.state_out.data;
            return out.spec_e.data;
          });
          queue = run.catch(() => void 0);
          return run;
        },
        reset() {
          queue = queue.then(() => {
            state = freshState(MODEL_INIT);
          });
        },
        close() {
        }
      };
    }
  };
}
async function webgpuEngine(selftest) {
  if (!model) throw new Error("no model");
  const gpu = navigator.gpu;
  if (!gpu) throw new Error("no WebGPU here");
  const adapter = await gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const info = adapter.info;
  const detail = `${info.vendor} ${info.architecture} ${info.description}`.trim();
  const gm = await GpuModel.create(
    device,
    plan(readInitializers(model), MODEL_INIT)
  );
  const want = new Float32Array(selftest);
  if (want.length !== SELFTEST_CHECK * SPEC2)
    throw new Error("bad self-test data");
  const s = gm.session();
  const outs = await Promise.all(
    Array.from(
      { length: SELFTEST_FRAMES },
      (_, t) => s.process(selftestFrame(t))
    )
  );
  s.destroy();
  const got = new Float32Array(SELFTEST_CHECK * SPEC2);
  outs.slice(SELFTEST_FRAMES - SELFTEST_CHECK).forEach(
    (o, i) => got.set(o, i * SPEC2)
  );
  const snr = snrDb(want, got);
  if (!(snr >= SELFTEST_MIN_SNR_DB)) {
    gm.destroy();
    device.destroy();
    throw new Error(
      `WebGPU self-test failed on ${detail}: ${snr.toFixed(1)} dB`
    );
  }
  const engine = {
    name: "webgpu",
    detail,
    dead: false,
    session() {
      const sess = gm.session();
      return {
        process: (spec) => sess.process(spec),
        reset: () => sess.reset(),
        close: () => sess.destroy()
      };
    }
  };
  device.lost.then((l) => {
    engine.dead = true;
    console.warn("DPDFNet: WebGPU device lost:", l.message);
  });
  return engine;
}
function serve(port, enginePromise) {
  let session = null;
  let last = Promise.resolve();
  let failed = false;
  const reply = (m) => port.postMessage(control(m));
  const fail = (err) => {
    if (failed) return;
    failed = true;
    reply({ type: "error", message: errorText(err) });
  };
  port.onmessage = (e) => {
    const data = e.data;
    if (typeof data === "string") {
      const msg = parseControl(data);
      if (msg?.type === "init") {
        enginePromise.then(
          (engine) => {
            session?.close();
            session = engine.session();
            failed = false;
            reply({ type: "ready", backend: engine.name });
          },
          (err) => reply({ type: "error", message: errorText(err) })
        );
      } else if (msg?.type === "reset") {
        session?.reset();
      } else if (msg?.type === "close") {
        session?.close();
        session = null;
        port.close();
      }
      return;
    }
    const frame = decodeFrame(data);
    if (!frame || !session || failed) return;
    const out = session.process(frame.spec);
    last = last.then(() => out).then(
      (spec) => port.postMessage(encodeFrame(frame.seq, spec)),
      fail
    );
  };
}
function start(m) {
  const fresh = () => {
    const p = m.engine === "wasm" ? wasmEngine(m) : webgpuEngine(m.selftest);
    engines.set(m.engine, p);
    p.catch(() => {
      if (engines.get(m.engine) === p) engines.delete(m.engine);
    });
    return p;
  };
  const existing = engines.get(m.engine);
  return existing ? existing.then((en) => en.dead ? fresh() : en, fresh) : fresh();
}
self.onmessage = (e) => {
  const m = e.data;
  if (m?.type === "model") {
    model = m.model;
  } else if (m?.type === "engine") {
    start(m).then(
      (en) => self.postMessage({
        type: "engine-ready",
        engine: m.engine,
        detail: en.detail
      }),
      (err) => self.postMessage({
        type: "engine-error",
        engine: m.engine,
        message: errorText(err)
      })
    );
  } else if (m?.type === "connect" && e.ports[0]) {
    const p = engines.get(m.engine) ?? Promise.reject(new Error(`${m.engine} isn't started`));
    serve(e.ports[0], p);
  }
};
