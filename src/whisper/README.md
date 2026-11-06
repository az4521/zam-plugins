# Voice message transcription

Turns voice messages into text on your device, with OpenAI's Whisper (the
`base` model, multilingual, 8-bit quantized). Nothing is sent anywhere.

Open a voice message's menu and choose **Transcribe**. The text shows under
the player and is kept on the device; **Hide transcript** removes it. The
language is detected from the first 30 seconds.

The first transcription downloads about 105 MB (the model and ONNX Runtime's
wasm build), checked against SHA-256 sums; after that it is offline. The
speech model runs in a Worker on the CPU, starts when you ask and stops after a
minute idle. Clips over 15 minutes are refused.

Needs Zam 1.55.0 or later (`zam.messages.annotate`, `zam.matrix.getMedia`).

Build: `npm run build:whisper` from the repo root.
