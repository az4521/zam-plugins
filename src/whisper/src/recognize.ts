/** Whisper through transformers.js: load the model, detect the language,
 *  transcribe. Kept apart from the Worker's plumbing so Node can run it. */
import { Tensor, pipeline } from "@huggingface/transformers";
import { MODEL_ID } from "./model";

/** The pipeline, typed only as far as this file uses it. */
export interface Recognizer {
    (audio: Float32Array, opts: Record<string, unknown>): Promise<unknown>;
    processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
    model: {
        generation_config: {
            lang_to_id: Record<string, number>;
            decoder_start_token_id: number;
        };
        (inputs: Record<string, unknown>): Promise<{ logits: Tensor }>;
    };
}

export async function loadRecognizer(
    device: "wasm" | "cpu",
): Promise<Recognizer> {
    return (await pipeline("automatic-speech-recognition", MODEL_ID, {
        dtype: "q8",
        device,
    })) as unknown as Recognizer;
}

const WINDOW = 30 * 16000;

/** The language Whisper thinks the first 30 s are in, as a code like "en".
 *  (transformers.js would assume English.) */
async function detectLanguage(
    rec: Recognizer,
    samples: Float32Array,
): Promise<string> {
    const { input_features } = await rec.processor(samples.subarray(0, WINDOW));
    const { lang_to_id, decoder_start_token_id } = rec.model.generation_config;
    const { logits } = await rec.model({
        input_features,
        decoder_input_ids: new Tensor(
            "int64",
            BigInt64Array.from([BigInt(decoder_start_token_id)]),
            [1, 1],
        ),
    });
    const scores = logits.data as Float32Array;
    let best = "en";
    let bestScore = -Infinity;
    for (const [token, id] of Object.entries(lang_to_id)) {
        if (scores[id] > bestScore) {
            bestScore = scores[id];
            best = token.slice(2, -2);
        }
    }
    return best;
}

export async function transcribe(
    rec: Recognizer,
    samples: Float32Array,
): Promise<string> {
    const language = await detectLanguage(rec, samples);
    const out = (await rec(samples, {
        task: "transcribe",
        language,
        chunk_length_s: 30,
        stride_length_s: 5,
    })) as { text: string } | { text: string }[];
    return (Array.isArray(out) ? out[0] : out).text.trim();
}
