/**
 * The speech recognizer, in a Worker. Every file it needs comes from the
 * plugin's own checksummed assets (the page passes blob: URLs); nothing is
 * fetched from the network.
 */
import { env } from "@huggingface/transformers";
import type { FromWorker, ToWorker } from "./protocol";
import { loadRecognizer, transcribe, type Recognizer } from "./recognize";

const post = (m: FromWorker) => postMessage(m);

let recognizer: Promise<Recognizer> | null = null;

function setup(
    files: Record<string, string>,
    ortGlue: string,
    ortWasm: string,
) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = "https://zam-plugin.invalid/";
    env.useBrowserCache = false;
    env.useCustomCache = true;
    // Model files are looked up by their path in the model's repo.
    env.customCache = {
        async match(request: string | Request) {
            const url = typeof request === "string" ? request : request.url;
            const at = url.indexOf("/resolve/");
            if (at < 0) return undefined;
            const blobUrl = files[url.slice(url.indexOf("/", at + 9) + 1)];
            return blobUrl ? await fetch(blobUrl) : undefined;
        },
        async put() {},
    };
    const wasm = env.backends.onnx.wasm!;
    wasm.wasmPaths = { mjs: ortGlue, wasm: ortWasm };
    wasm.proxy = false;
    wasm.numThreads = Math.max(
        1,
        Math.min(4, (navigator.hardwareConcurrency ?? 2) >> 1),
    );
    return loadRecognizer("wasm");
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    try {
        if (m.type === "init") {
            recognizer = setup(m.files, m.ortGlue, m.ortWasm);
            await recognizer;
            post({ type: "ready" });
        } else if (m.type === "transcribe") {
            if (!recognizer) throw new Error("not initialised");
            post({
                type: "result",
                id: m.id,
                text: await transcribe(await recognizer, m.samples),
            });
        }
    } catch (err) {
        post({
            type: "error",
            id: m.type === "transcribe" ? m.id : undefined,
            message: err instanceof Error ? err.message : String(err),
        });
    }
};
