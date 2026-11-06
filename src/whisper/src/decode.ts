/** Decode an audio file to the 16 kHz mono samples Whisper takes. */
export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
    const bytes = await blob.arrayBuffer();
    // The context's rate is what decodeAudioData resamples to.
    const ctx = new OfflineAudioContext(1, 1, 16000);
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
