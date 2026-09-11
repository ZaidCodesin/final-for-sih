'use strict';
/* ProtecT voice model fetcher — free, offline-first on-device AI speech-to-text.
 *
 * Downloads the vendored runtime + Whisper model files into public/vendor/voice
 * so the journal Speak feature works offline with no API key and no cost:
 *
 *   npm run fetch-voice-model
 *
 * Files are served by the existing Express static middleware. Model binaries are
 * git-ignored (public/vendor/*); only the loader and docs are committed.
 * Re-run with --model=Xenova/whisper-small for the larger, more accurate model.
 */
const fs = require('fs');
const path = require('path');

const RUNTIME_VERSION = '2.17.2';
const DEFAULT_MODEL = 'Xenova/whisper-base';
const RUNTIME_BASE = `https://cdn.jsdelivr.net/npm/@xenova/transformers@${RUNTIME_VERSION}/dist`;
const HF_BASE = 'https://huggingface.co';

// All four WASM backends: threaded builds need cross-origin isolation headers
// (which this server does not send), so plain localhost falls back to the
// non-threaded SIMD build. Vendoring every variant keeps startup working
// everywhere instead of failing on a 404 for a missing .wasm file.
const RUNTIME_FILES = ['transformers.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-threaded.wasm', 'ort-wasm-simd.wasm', 'ort-wasm.wasm'];
// Quantized ONNX weights (~121MB for whisper-base) + tokenizer/config sidecars.
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
  'added_tokens.json',
  'normalizer.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  'onnx/decoder_with_past_model_quantized.onnx',
];

function argValue(name) {
  const hit = process.argv.find(arg => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error(`Empty response for ${url}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buffer);
  return buffer.length;
}

async function main() {
  const model = argValue('--model') || process.env.ProtecT_VOICE_MODEL || DEFAULT_MODEL;
  const root = path.join(__dirname, '..', 'public', 'vendor', 'voice');
  const manifest = { runtime: RUNTIME_VERSION, model, fetched_at: new Date().toISOString(), files: [] };
  let bytes = 0;

  for (const file of RUNTIME_FILES) {
    const size = await download(`${RUNTIME_BASE}/${encodeURI(file)}`, path.join(root, file));
    manifest.files.push({ url: `${RUNTIME_BASE}/${file}`, path: file, bytes: size });
    bytes += size;
    console.log(`  + ${file} (${(size / 1048576).toFixed(1)} MB)`);
  }
  for (const file of MODEL_FILES) {
    const size = await download(`${HF_BASE}/${model}/resolve/main/${encodeURI(file)}`, path.join(root, 'models', model, file));
    manifest.files.push({ url: `${HF_BASE}/${model}/resolve/main/${file}`, path: `models/${model}/${file}`, bytes: size });
    bytes += size;
    console.log(`  + models/${model}/${file} (${(size / 1048576).toFixed(1)} MB)`);
  }
  // Optional sidecars (bnb4 configs exist on some repos); skip quietly when absent.
  for (const file of ['quant_config.json', 'quantize_config.json']) {
    try {
      const size = await download(`${HF_BASE}/${model}/resolve/main/${encodeURI(file)}`, path.join(root, 'models', model, file));
      manifest.files.push({ url: `${HF_BASE}/${model}/resolve/main/${file}`, path: `models/${model}/${file}`, bytes: size });
      bytes += size;
      console.log(`  + models/${model}/${file} (${(size / 1024).toFixed(1)} KB)`);
    } catch {
      console.log(`  · models/${model}/${file} not published — skipped`);
    }
  }
  await fs.promises.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nVoice assets ready → public/vendor/voice (${(bytes / 1048576).toFixed(0)} MB total, model ${model}).`);
  console.log('These files are git-ignored; each machine or deploy runs this script once.');
}

main().catch(error => {
  console.error(`Voice model fetch failed: ${error.message}`);
  process.exit(1);
});
