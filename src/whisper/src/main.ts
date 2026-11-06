/**
 * Zam plugin: transcribe voice messages on your device. Adds "Transcribe" to
 * a voice message's menu; the text shows under the player and is kept on the
 * device. Whisper runs in a Worker (see worker.ts); it starts when you first
 * ask for a transcript and stops again after a minute idle.
 */
import type {
    Disposable,
    PluginModule,
    ZamPluginApi,
} from "../../../zam-api/plugins/types";
import { decodeTo16kMono } from "./decode";
import { MODEL_FILES, assetPath } from "./model";
import type { FromWorker, ToWorker } from "./protocol";

const ASSETS = {
    worker: "assets/worker.js",
    ortGlue: "assets/ort-wasm-simd-threaded.asyncify.mjs",
    ortWasm: "assets/ort-wasm-simd-threaded.asyncify.wasm",
};
const IDLE_MS = 60_000;
const KEEP = 300;
/** Longest clip worth transcribing here (the decoded samples alone are
 *  3.8 MB a minute). */
const MAX_SECONDS = 15 * 60;

type Entry = { status: "busy" | "done" | "error"; text: string };

/** Pending-request id for the worker's init handshake. */
const INIT = 0;

class Recognizer {
    private worker: Worker | null = null;
    private ready: Promise<Worker> | null = null;
    private urls: string[] = [];
    private pending = new Map<
        number,
        { resolve(t: string): void; reject(e: Error): void }
    >();
    private nextId = 1;
    private idle: ReturnType<typeof setTimeout> | undefined;

    constructor(private zam: ZamPluginApi) {}

    private async start(): Promise<Worker> {
        const url = async (path: string, type: string) => {
            const u = await this.zam.assets.url(path, type);
            this.urls.push(u);
            return u;
        };
        const [workerUrl, ortGlue, ortWasm] = await Promise.all([
            url(ASSETS.worker, "text/javascript"),
            url(ASSETS.ortGlue, "text/javascript"),
            url(ASSETS.ortWasm, "application/wasm"),
        ]);
        const files: Record<string, string> = {};
        for (const f of MODEL_FILES)
            files[f] = await url(
                assetPath(f),
                f.endsWith(".json")
                    ? "application/json"
                    : "application/octet-stream",
            );
        const w = new Worker(workerUrl, { type: "module" });
        this.worker = w;
        w.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
        w.onerror = (e) => this.fail(new Error(e.message || "worker failed"));
        await new Promise<void>((resolve, reject) => {
            this.pending.set(INIT, { resolve: () => resolve(), reject });
            const init: ToWorker = { type: "init", files, ortGlue, ortWasm };
            w.postMessage(init);
        });
        return w;
    }

    private onMessage(m: FromWorker) {
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

    private fail(err: Error) {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.stop();
    }

    /** Whether the model is on the device already. */
    async cached(): Promise<boolean> {
        const files = [
            ASSETS.worker,
            ASSETS.ortWasm,
            ...MODEL_FILES.map(assetPath),
        ];
        for (const f of files)
            if (!(await this.zam.assets.cached(f))) return false;
        return true;
    }

    async transcribe(samples: Float32Array): Promise<string> {
        clearTimeout(this.idle);
        this.ready ??= this.start().catch((e) => {
            this.ready = null;
            this.stop();
            throw e;
        });
        const w = await this.ready;
        const id = this.nextId++;
        try {
            return await new Promise<string>((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                const m: ToWorker = { type: "transcribe", id, samples };
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
}

let cleanup: (() => void) | null = null;

const plugin: PluginModule = {
    onload(zam) {
        const recognizer = new Recognizer(zam);
        const key = (roomId: string, eventId: string) => `${roomId}|${eventId}`;
        const stored = zam.storage.get<Record<string, string>>(
            "transcripts",
            {},
        );
        const entries = new Map<string, Entry>(
            Object.entries(stored).map(([k, text]) => [
                k,
                { status: "done", text },
            ]),
        );
        const persist = () => {
            const done = [...entries].filter(([, e]) => e.status === "done");
            zam.storage.set(
                "transcripts",
                Object.fromEntries(
                    done.slice(-KEEP).map(([k, e]) => [k, e.text]),
                ),
            );
        };
        const statusOf = (ctx: { roomId: string; eventId: string }) =>
            entries.get(key(ctx.roomId, ctx.eventId))?.status;
        // One at a time: the model is the bottleneck, and parallel decodes
        // would only compete for memory.
        let chain: Promise<unknown> = Promise.resolve();

        const run = async (roomId: string, eventId: string) => {
            const k = key(roomId, eventId);
            entries.set(k, { status: "busy", text: "" });
            zam.messages.refresh();
            try {
                const { blob } = await zam.matrix.getMedia(roomId, eventId);
                const samples = await decodeTo16kMono(blob);
                if (samples.length > MAX_SECONDS * 16000)
                    throw new Error("too long to transcribe here");
                const text = await recognizer.transcribe(samples);
                entries.set(k, {
                    status: "done",
                    text: text || "(no speech found)",
                });
                persist();
            } catch (e) {
                console.error("[whisper] transcription failed", e);
                entries.set(k, {
                    status: "error",
                    text: `Couldn't transcribe: ${e instanceof Error ? e.message : String(e)}`,
                });
            }
            zam.messages.refresh();
        };

        const disposables: Disposable[] = [
            zam.messages.addAction({
                id: "transcribe",
                label: "Transcribe",
                when: (ctx) =>
                    ctx.msgtype === "m.audio" &&
                    statusOf(ctx) !== "busy" &&
                    statusOf(ctx) !== "done",
                onSelect: async (ctx) => {
                    if (!(await recognizer.cached()))
                        zam.ui.notify({
                            title: "Transcribe",
                            body: "Downloading the speech model (about 80 MB), once.",
                        });
                    chain = chain.then(() => run(ctx.roomId, ctx.eventId));
                },
            }),
            zam.messages.addAction({
                id: "hide-transcript",
                label: "Hide transcript",
                when: (ctx) =>
                    ctx.msgtype === "m.audio" &&
                    (statusOf(ctx) === "done" || statusOf(ctx) === "error"),
                onSelect: (ctx) => {
                    entries.delete(key(ctx.roomId, ctx.eventId));
                    persist();
                    zam.messages.refresh();
                },
            }),
            zam.messages.annotate((ctx) => {
                const e = entries.get(key(ctx.roomId, ctx.eventId));
                if (!e) return null;
                return e.status === "busy"
                    ? { text: "Transcribing…", busy: true }
                    : { text: e.text };
            }),
        ];
        cleanup = () => {
            for (const d of disposables) d.dispose();
            recognizer.stop();
        };
    },
    onunload() {
        cleanup?.();
        cleanup = null;
    },
};

export default plugin;
