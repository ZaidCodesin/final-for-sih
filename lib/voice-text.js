'use strict';
/* ProtecT pure-logic voice transcript helpers â€” shared by the browser journal
 * voice engine and the regression suite (no DOM, no audio, no network).
 *
 * Chunk-merging, repetition guards, and language mapping are tested
 * deterministically with: npm test
 */

/** Longest word-level overlap where the tail of `prev` equals the head of `next`. */
function overlapWords(prev, next) {
  const a = String(prev || '').trim().split(/\s+/).filter(Boolean);
  const b = String(next || '').trim().split(/\s+/).filter(Boolean);
  if (!a.length || !b.length) return 0;
  const limit = Math.min(a.length, b.length, 40);
  for (let size = limit; size > 0; size--) {
    let match = true;
    for (let i = 0; i < size; i++) {
      if (a[a.length - size + i].toLocaleLowerCase() !== b[i].toLocaleLowerCase()) { match = false; break; }
    }
    if (match) return size;
  }
  return 0;
}

/** Merge a new transcript chunk into the running session text without repeating the overlapped tail. */
function mergeChunkText(prevText, chunkText) {
  const prev = String(prevText || '').trim();
  const chunk = String(chunkText || '').trim();
  if (!prev) return chunk;
  if (!chunk) return prev;
  const overlap = overlapWords(prev, chunk);
  if (overlap > 0) {
    const tail = chunk.split(/\s+/).slice(overlap).join(' ').trim();
    return tail ? `${prev} ${tail}` : prev;
  }
  return `${prev} ${chunk}`;
}

function normalizeFingerprint(text) {
  return String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Near-duplicate guard: exact, containment, or high token overlap within a window. */
function isNearDuplicate(candidate, recentFingerprints) {
  const fp = normalizeFingerprint(candidate);
  if (!fp) return true;
  const words = new Set(fp.split(' ').filter(Boolean));
  for (const item of recentFingerprints || []) {
    const other = typeof item === 'string' ? item : item.fp;
    if (!other) continue;
    // Exact: differs only in punctuation/case.
    if (other === fp) return true;
    // Containment: one phrase fully inside the other (the classic "5 repeats" case).
    if (other.includes(fp) || fp.includes(other)) return true;
    // Fuzzy: Jaccard token overlap >= 0.8 on phrases of 3+ words.
    const otherWords = other.split(' ').filter(Boolean);
    if (words.size >= 3 && otherWords.length >= 3) {
      const otherSet = new Set(otherWords);
      let shared = 0;
      for (const word of words) if (otherSet.has(word)) shared++;
      if (shared / Math.max(words.size, otherSet.size) >= 0.8) return true;
    }
  }
  return false;
}

/** Collapse pathological in-chunk loops ("gaya gaya gaya gaya") down to one instance. */
function collapseRepeats(text, maxRun = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const out = [words[0]];
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i].toLocaleLowerCase() === words[i - 1].toLocaleLowerCase()) {
      run++;
      if (run <= maxRun) out.push(words[i]);
    } else {
      run = 1;
      out.push(words[i]);
    }
  }
  return out.join(' ');
}

/** Map the journal language selector to a Whisper language/task hint. */
function whisperHint(journalLangValue) {
  const value = String(journalLangValue || 'auto').toLowerCase();
  if (value === 'auto') return { language: undefined, task: 'transcribe' };
  const code = value.split('-')[0];
  const supported = ['en', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'or', 'ur'];
  return { language: supported.includes(code) ? code : undefined, task: 'transcribe' };
}

/** Classify a getUserMedia failure into actionable UI copy (fixes silent PC failures). */
function micErrorKind(error) {
  const name = (error && (error.name || error.code)) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'unavailable';
}

module.exports = { overlapWords, mergeChunkText, normalizeFingerprint, isNearDuplicate, collapseRepeats, whisperHint, micErrorKind };
