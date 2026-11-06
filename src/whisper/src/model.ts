/** The model's files, from onnx-community/whisper-base (a Whisper port to
 *  ONNX, 8-bit quantized), by their path in that repo. */
export const MODEL_ID = "onnx-community/whisper-base";
export const MODEL_FILES = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
];
/** Where a model file lives in the plugin (manifest `assets`). */
export const assetPath = (file: string): string => `assets/model/${file}`;
