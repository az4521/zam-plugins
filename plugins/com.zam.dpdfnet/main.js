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

// plugins/dpdfnet/model/dpdfnet2_48khz_hr.init.json
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

// plugins/dpdfnet/src/protocol.ts
var control = (m) => JSON.stringify(m);
function initMessage(threads, modelBytes) {
  return control({
    type: "init",
    threads,
    stateSize: dpdfnet2_48khz_hr_init_default.stateSize,
    erbNormInit: dpdfnet2_48khz_hr_init_default.erbNormInit,
    specNormInit: dpdfnet2_48khz_hr_init_default.specNormInit,
    modelBytes
  });
}
function parseReply(data) {
  if (typeof data !== "string") return null;
  try {
    const m = JSON.parse(data);
    return m?.type === "ready" || m?.type === "error" ? m : null;
  } catch {
    return null;
  }
}

// plugins/dpdfnet/src/backend.ts
var DPDFNET_SAMPLE_RATE = 48e3;
var DPDFNET_ATTENUATION_DB = 25;
var ASSETS = {
  worklet: "assets/worklet.js",
  worker: "assets/worker.js",
  model: "assets/model.onnx",
  ortModule: "assets/ort.wasm.min.mjs",
  ortGlue: "assets/ort-wasm-simd-threaded.mjs",
  ortWasm: "assets/ort-wasm-simd-threaded.wasm",
  selftest: "assets/selftest.bin"
};
var SLACK_GROWTH = 8;
var SLACK_LIMIT = 40;
function slackFor(baseLatencyS) {
  const burst = Math.ceil((baseLatencyS > 0 ? baseLatencyS : 0.01) * 100);
  const slack = Math.min(SLACK_LIMIT - SLACK_GROWTH, Math.max(2, burst + 1));
  return { slack, maxSlack: slack + SLACK_GROWTH };
}
var BENCH_MAX_FRAME_MS = 6;
var BENCH_MAX_LATENCY_MS = 15;
var BENCH_DEPTH = 2;
var BENCH_WARMUP = 8;
var BENCH_FRAMES = 32;
var INIT_TIMEOUT_MS = 3e4;
var VERDICT_TTL_MS = 14 * 24 * 3600 * 1e3;
var STALLED_TTL_MS = 3600 * 1e3;
var UNAVAILABLE_TTL_MS = 24 * 3600 * 1e3;
var VERDICT_KEY = "verdict";
var GPU_VERDICT_KEY = "verdict-webgpu";
function readVerdict(store, now = Date.now(), key = VERDICT_KEY) {
  const v = store.get(key, null);
  if (!v || typeof v.ok !== "boolean" || typeof v.at !== "number")
    return null;
  const ttl = v.reason === "stalled" ? STALLED_TTL_MS : v.reason === "unavailable" ? UNAVAILABLE_TTL_MS : VERDICT_TTL_MS;
  return now - v.at > ttl ? null : v;
}
function fastEnough(r) {
  return r.frameMs <= BENCH_MAX_FRAME_MS && r.p90Ms <= BENCH_MAX_LATENCY_MS;
}
var TooSlowError = class extends Error {
};
function createOverloadMonitor(maxSlack, fail) {
  let prev = null;
  let stalled = 0;
  let overloaded = 0;
  let done = false;
  return (s) => {
    if (done) return;
    if (prev) {
      const frames = s.frames - prev.frames;
      const misses = s.misses - prev.misses;
      stalled = s.received === prev.received && s.sent + s.skipped > prev.sent + prev.skipped ? stalled + 1 : 0;
      overloaded = s.slack >= maxSlack && frames > 0 && misses / frames > 0.05 ? overloaded + 1 : 0;
      const reason = stalled >= 3 ? "stalled" : overloaded >= 3 ? "overload" : null;
      if (reason) {
        done = true;
        fail(reason);
      }
    }
    prev = s;
  };
}
function nextMessage(port, pick, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.onmessage = null;
      reject(new Error("DPDFNet backend timed out"));
    }, timeoutMs);
    port.onmessage = (e) => {
      let v;
      try {
        v = pick(e.data);
      } catch (err) {
        clearTimeout(timer);
        port.onmessage = null;
        reject(err);
        return;
      }
      if (v === null) return;
      clearTimeout(timer);
      port.onmessage = null;
      resolve(v);
    };
  });
}
function benchmark(port) {
  let seed = 7;
  const rand = () => (seed = seed * 1103515245 + 12345 & 2147483647) / 2147483647 * 2 - 1;
  const spec = new Float32Array(DPDF_BINS * 2);
  const total = BENCH_WARMUP + BENCH_FRAMES;
  const sentAt = /* @__PURE__ */ new Map();
  const times = [];
  let next = 0;
  let answered = 0;
  let timedFrom = 0;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (err, r) => {
      clearTimeout(timer);
      port.onmessage = null;
      if (err) reject(err);
      else resolve(r);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(new Error("DPDFNet backend timed out")),
        2e3
      );
    };
    const send = () => {
      for (let k = 0; k < spec.length; k++) spec[k] = rand() * 0.5;
      sentAt.set(next, performance.now());
      port.postMessage(encodeFrame(next++, spec));
    };
    port.onmessage = (e) => {
      const r = parseReply(e.data);
      if (r?.type === "error") return finish(new Error(r.message));
      const f = decodeFrame(e.data);
      const t0 = f ? sentAt.get(f.seq) : void 0;
      if (!f || t0 === void 0) return;
      sentAt.delete(f.seq);
      const now = performance.now();
      if (f.seq >= BENCH_WARMUP) times.push(now - t0);
      else if (f.seq === BENCH_WARMUP - 1) timedFrom = now;
      if (++answered === total) {
        times.sort((a, b) => a - b);
        return finish(null, {
          medianMs: times[Math.floor(times.length / 2)],
          p90Ms: times[Math.floor(times.length * 0.9)],
          frameMs: (now - timedFrom) / BENCH_FRAMES
        });
      }
      arm();
      if (next < total) send();
    };
    arm();
    for (let i = 0; i < BENCH_DEPTH; i++) send();
  });
}
function closePort(port) {
  try {
    port.postMessage(control({ type: "close" }));
  } catch {
  }
  port.close();
}
var webgpuPossible = () => typeof navigator !== "undefined" && "gpu" in navigator;
function dpdfnetSupported() {
  return typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined" && typeof Worker !== "undefined" && typeof MessageChannel !== "undefined";
}
function createDpdfnet(zam) {
  const writeVerdict = (v) => zam.storage.set(
    v.backend === "webgpu" ? GPU_VERDICT_KEY : VERDICT_KEY,
    v
  );
  const cpuRuledOut = () => readVerdict(zam.storage)?.ok === false;
  const gpuRuledOut = () => !webgpuPossible() || readVerdict(zam.storage, Date.now(), GPU_VERDICT_KEY)?.ok === false;
  const knownTooSlow = () => cpuRuledOut() && gpuRuledOut();
  let worker = null;
  async function ensureWorker() {
    if (worker) return worker;
    const [workerUrl, model] = await Promise.all([
      zam.assets.url(ASSETS.worker, "text/javascript"),
      zam.assets.get(ASSETS.model)
    ]);
    if (worker) return worker;
    const w = new Worker(workerUrl, {
      type: "module",
      name: "zam-dpdfnet"
    });
    w.postMessage({ type: "model", model }, [
      model
    ]);
    const entry = { w, engines: /* @__PURE__ */ new Map() };
    worker = entry;
    w.addEventListener("error", (e) => {
      console.warn("DPDFNet Worker:", e.message);
      if (worker === entry) worker = null;
      w.terminate();
    });
    return entry;
  }
  function ensureEngine(wk, engine) {
    const started = wk.engines.get(engine);
    if (started) return started;
    const p = new Promise((resolve, reject) => {
      const done = () => {
        wk.w.removeEventListener("message", onMessage);
        wk.w.removeEventListener("error", onError);
      };
      const onMessage = (e) => {
        const d = e.data;
        if (d?.engine !== engine) return;
        if (d.type === "engine-ready") resolve(d.detail);
        else if (d.type === "engine-error")
          reject(new Error(d.message));
        else return;
        done();
      };
      const onError = (e) => {
        done();
        reject(
          new Error(e.message || "the DPDFNet Worker didn't start")
        );
      };
      wk.w.addEventListener("message", onMessage);
      wk.w.addEventListener("error", onError);
      (async () => {
        if (engine === "webgpu") {
          const selftest = await zam.assets.get(ASSETS.selftest);
          wk.w.postMessage(
            {
              type: "engine",
              engine,
              selftest
            },
            [selftest]
          );
        } else {
          const [ortModuleUrl, ortGlueUrl, ortWasm] = await Promise.all([
            zam.assets.url(ASSETS.ortModule, "text/javascript"),
            zam.assets.url(ASSETS.ortGlue, "text/javascript"),
            zam.assets.get(ASSETS.ortWasm)
          ]);
          wk.w.postMessage(
            {
              type: "engine",
              engine,
              ortModuleUrl,
              ortGlueUrl,
              ortWasm
            },
            [ortWasm]
          );
        }
      })().catch((err) => {
        done();
        reject(err);
      });
    });
    wk.engines.set(engine, p);
    p.catch(() => {
      if (wk.engines.get(engine) === p) wk.engines.delete(engine);
    });
    return p;
  }
  async function open(kind) {
    if (kind === "native") {
      const [port, model] = await Promise.all([
        zam.native.connect(),
        zam.assets.get(ASSETS.model)
      ]);
      return { b: { kind, port, close: () => closePort(port) }, model };
    }
    const wk = await ensureWorker();
    const engine = kind === "webgpu" ? "webgpu" : "wasm";
    const gpu = await ensureEngine(wk, engine);
    if (gpu) console.info(`DPDFNet on WebGPU: ${gpu}`);
    const ch = new MessageChannel();
    wk.w.postMessage({ type: "connect", engine }, [
      ch.port2
    ]);
    return {
      b: { kind, port: ch.port1, close: () => closePort(ch.port1) }
    };
  }
  async function initBackend(b, model) {
    const ready = nextMessage(b.port, parseReply, INIT_TIMEOUT_MS);
    b.port.postMessage(initMessage(1, model?.byteLength));
    if (model) b.port.postMessage(model);
    const reply = await ready;
    if (reply.type === "error") throw new Error(reply.message);
  }
  async function startBackend() {
    const order = [];
    if (!gpuRuledOut()) order.push("webgpu");
    if (!cpuRuledOut()) {
      if (zam.native.available()) order.push("native");
      order.push("worker");
    }
    let lastErr = new TooSlowError(
      "DPDFNet was too slow on this device"
    );
    const gpuFailed = (reason) => writeVerdict({
      ok: false,
      backend: "webgpu",
      medianMs: null,
      reason,
      at: Date.now()
    });
    for (const kind of order) {
      let b = null;
      try {
        const opened = await open(kind);
        b = opened.b;
        await initBackend(b, opened.model);
      } catch (err) {
        console.warn(`DPDFNet ${kind} backend unavailable:`, err);
        b?.close();
        lastErr = err;
        if (kind === "webgpu")
          gpuFailed(
            String(err).includes("self-test") ? "selftest" : "unavailable"
          );
        continue;
      }
      let r;
      try {
        r = await benchmark(b.port);
      } catch (err) {
        b.close();
        if (kind !== "webgpu") throw err;
        console.warn("DPDFNet webgpu backend failed:", err);
        gpuFailed("stalled");
        lastErr = err;
        continue;
      }
      const ok = fastEnough(r);
      writeVerdict({
        ok,
        backend: kind,
        medianMs: Math.round(r.medianMs * 100) / 100,
        reason: ok ? void 0 : "benchmark",
        at: Date.now()
      });
      if (!ok) {
        b.close();
        const msg = `DPDFNet too slow here (${kind}: a frame per ${r.frameMs.toFixed(1)} ms, round trip p90 ${r.p90Ms.toFixed(1)} ms)`;
        if (kind !== "webgpu") throw new TooSlowError(msg);
        console.info(msg);
        lastErr = new TooSlowError(msg);
        continue;
      }
      b.port.postMessage(control({ type: "reset" }));
      return b;
    }
    throw lastErr;
  }
  const workletLoaded = /* @__PURE__ */ new WeakMap();
  async function create(ctx) {
    if (!dpdfnetSupported()) throw new Error("DPDFNet can't run here");
    if (ctx.sampleRate !== DPDFNET_SAMPLE_RATE)
      throw new Error(`DPDFNet needs 48 kHz, got ${ctx.sampleRate}`);
    if (knownTooSlow())
      throw new TooSlowError("DPDFNet was too slow on this device");
    let loaded = workletLoaded.get(ctx);
    if (!loaded) {
      loaded = zam.assets.url(ASSETS.worklet, "text/javascript").then((url) => ctx.audioWorklet.addModule(url));
      workletLoaded.set(ctx, loaded);
      loaded.catch(() => workletLoaded.delete(ctx));
    }
    const [backend] = await Promise.all([startBackend(), loaded]);
    const { slack, maxSlack } = slackFor(ctx.baseLatency);
    const node = new AudioWorkletNode(ctx, "zam-dpdfnet", {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: {
        attenuationDb: DPDFNET_ATTENUATION_DB,
        slack,
        maxSlack
      }
    });
    const inst = {
      node,
      dryOutput: 1,
      onFailure: null,
      close() {
        node.port.onmessage = null;
        node.port.postMessage({ type: "stop" });
        backend.close();
      }
    };
    const monitor = createOverloadMonitor(maxSlack, (reason) => {
      writeVerdict({
        ok: false,
        backend: backend.kind,
        medianMs: null,
        reason,
        at: Date.now()
      });
      inst.onFailure?.(reason);
    });
    let relay = false;
    try {
      node.port.postMessage({ type: "backend" }, [backend.port]);
    } catch {
      relay = true;
      node.port.postMessage({ type: "relay" });
      backend.port.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer || ArrayBuffer.isView(e.data))
          node.port.postMessage(e.data);
      };
    }
    node.port.onmessage = (e) => {
      const d = e.data;
      if (relay && (d instanceof ArrayBuffer || ArrayBuffer.isView(d)))
        backend.port.postMessage(d);
      else if (d?.type === "stats") monitor(d);
    };
    return inst;
  }
  async function prepare(timeoutMs) {
    if (!dpdfnetSupported() || knownTooSlow()) return "failed";
    let timer;
    const work = (async () => {
      (await startBackend()).close();
      return "ready";
    })().catch((err) => {
      if (err instanceof TooSlowError) console.info(err.message);
      else console.warn("DPDFNet unavailable:", err);
      return "failed";
    });
    try {
      return await Promise.race([
        work,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function prefetch() {
    if (!dpdfnetSupported()) return;
    for (const p of Object.values(ASSETS))
      if (!await zam.assets.cached(p)) await zam.assets.get(p);
  }
  function dispose2() {
    worker?.w.terminate();
    worker = null;
  }
  return {
    available: () => dpdfnetSupported() && !knownTooSlow(),
    create,
    prepare,
    prefetch,
    dispose: dispose2
  };
}

// plugins/dpdfnet/src/main.ts
var dispose = null;
var plugin = {
  onload(zam) {
    const d = createDpdfnet(zam);
    dispose = d.dispose;
    zam.audio.registerMicFilter({
      id: "dpdfnet",
      label: "DPDFNet",
      description: "AI noise removal that runs on your device, clearer than DeepFilterNet3 but heavier: devices too slow for it use DeepFilterNet3 instead. Downloads about 25 MB the first time (in the desktop and Android apps, another 25 to 45 MB for its native runtime).",
      available: d.available,
      prepare: d.prepare,
      prefetch: d.prefetch,
      create: d.create
    });
  },
  onunload() {
    dispose?.();
    dispose = null;
  }
};
var main_default = plugin;
export {
  main_default as default
};
