'use strict';
/* SENTINEL on-device journal voice worker — real AI speech-to-text in the page.
 *
 * Runs the vendored Transformers.js runtime + quantized Whisper model off the
 * main thread. The main thread streams 16 kHz mono PCM chunks here; this worker
 * loads the model once (with progress callbacks) and returns transcripts.
 * No audio or text ever leaves the device. Plain worker (no modules) so it runs
 * from the file://-safe, CSP `script-src 'self'` static bundle.
 */
let pipelinePromise = null;
let runtimeReady = false;

function vendorUrl(file) {
  const base = self.location.origin + self.location.pathname.replace(/\/[^/]*$/, '/vendor/voice/');
  return base + file;
}

async function ensurePipeline(onProgress) {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    self.importScripts(vendorUrl('transformers.min.js'));
    const T = self.transformers;
    if (!T || !T.pipeline) throw new Error('Voice AI runtime failed to load.');
    T.env.allowLocalModels = true;
    T.env.allowRemoteModels = false;
    T.env.localModelPath = vendorUrl('models/');
    // Plain localhost serves no cross-origin-isolation headers, so the
    // threaded WASM build cannot start (SharedArrayBuffer is unavailable).
    // Force the single-threaded build: stable everywhere, no special headers.
    T.env.backends = T.env.backends || {};
    if (T.env.backends.onnx) {
      T.env.backends.onnx.wasm = Object.assign(T.env.backends.onnx.wasm || {}, {
        wasmPaths: vendorUrl(''),
        numThreads: 1,
      });
    }
    const pipe = await T.pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
      quantized: true,
      progress_callback: onProgress || null,
    });
    runtimeReady = true;
    return pipe;
  })().catch(error => { pipelinePromise = null; throw error; });
  return pipelinePromise;
}

self.onmessage = async event => {
  const msg = event.data || {};
  try {
    if (msg.type === 'diag') {
      let runtime = 'missing';
      try { self.importScripts(vendorUrl('transformers.min.js')); runtime = (self.transformers && self.transformers.pipeline) ? 'runtime-ok' : 'runtime-broken'; }
      catch (error) { runtime = `runtime-failed: ${String((error && error.message) || error)}`; }
      const probe = async url => { try { const r = await fetch(url, { method: 'HEAD' }); return `${r.status}`; } catch (error) { return `fetch-failed: ${String((error && error.message) || error)}`; } };
      self.postMessage({
        type: 'diag', session: msg.session, runtime,
        threaded: typeof SharedArrayBuffer !== 'undefined' ? 'shared-memory-available' : 'shared-memory-unavailable (single-thread mode)',
        worker: vendorUrl('transformers.min.js'),
        encoder: await probe(vendorUrl('models/Xenova/whisper-base/onnx/encoder_model_quantized.onnx')),
      });
    } else if (msg.type === 'load') {
      await ensurePipeline(progress => {
        if (!progress) return;
        self.postMessage({ type: 'progress', session: msg.session, file: progress.file || '', progress: progress.progress, loaded: progress.loaded, total: progress.total, status: progress.status });
      });
      self.postMessage({ type: 'ready', session: msg.session, runtime: runtimeReady });
    } else if (msg.type === 'transcribe') {
      const pipe = await ensurePipeline(null);
      const result = await pipe(msg.audio, {
        language: msg.language || undefined,
        task: 'transcribe',
        return_timestamps: false,
      });
      const text = Array.isArray(result) ? result.map(part => part.text || '').join(' ').trim() : String((result && result.text) || '').trim();
      self.postMessage({ type: 'transcript', id: msg.id, session: msg.session, text });
    } else if (msg.type === 'unload') {
      pipelinePromise = null;
      runtimeReady = false;
      self.postMessage({ type: 'unloaded' });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: msg.id, session: msg.session, message: String((error && error.message) || error || 'Voice AI failed.') });
  }
};
