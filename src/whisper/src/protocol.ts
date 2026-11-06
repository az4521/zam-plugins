/** Messages between the plugin page and its Worker. */

export interface InitMessage {
    type: "init";
    /** blob: URL for each model file, by its path in the model's repo
     *  (`onnx/encoder_model_quantized.onnx`, `config.json`, ...). */
    files: Record<string, string>;
    /** ONNX Runtime Web's glue module and wasm file, as blob: URLs. */
    ortGlue: string;
    ortWasm: string;
}

export interface TranscribeMessage {
    type: "transcribe";
    id: number;
    /** 16 kHz mono samples. */
    samples: Float32Array;
}

export type ToWorker = InitMessage | TranscribeMessage;

export type FromWorker =
    | { type: "ready" }
    | { type: "result"; id: number; text: string }
    | { type: "error"; id?: number; message: string };
