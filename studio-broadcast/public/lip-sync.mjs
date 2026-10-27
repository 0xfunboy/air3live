/** A small, provider-independent timeline. Times are seconds on the audio clock. */
export const MOUTH_SHAPES = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X']);
const VALID = new Set(MOUTH_SHAPES);
export const MAX_MOUTH_CUES = 6000;

export function normalizeMouthCues(value, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600 ||
      !Array.isArray(value) || value.length > MAX_MOUTH_CUES) throw new Error('INVALID_LIP_SYNC_TIMELINE');
  let lastEnd = 0;
  return value.map((cue) => {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
        cue.start < 0 || cue.end <= cue.start || cue.start < lastEnd - 0.001 ||
        cue.end > duration + 0.06 || !VALID.has(cue.value)) throw new Error('INVALID_LIP_SYNC_CUE');
    const normalized = { start: Math.min(duration, cue.start), end: Math.min(duration, cue.end), value: cue.value };
    if (normalized.end <= normalized.start) throw new Error('INVALID_LIP_SYNC_CUE');
    lastEnd = normalized.end;
    return normalized;
  });
}

export function mouthCueAt(cues, elapsed, duration = Infinity) {
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= duration || !cues?.length) return 'X';
  let low = 0, high = cues.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1, cue = cues[mid];
    if (elapsed < cue.start) high = mid - 1;
    else if (elapsed >= cue.end) low = mid + 1;
    else return cue.value;
  }
  return 'X';
}

/**
 * Continuous cue weights on the authoritative audio clock. A compact smooth
 * kernel spans 90 ms and anticipates by 14 ms; adjacent poses share influence
 * across their real alignment boundary. Silence remains X, including gaps.
 * This has no render-frame-dependent timer and invents no phoneme timestamps.
 */
export function mouthPoseWeightsAt(cues, elapsed, duration = Infinity) {
  const weights = Object.fromEntries(MOUTH_SHAPES.map(name => [name, 0]));
  weights.X = 1;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= duration || !cues?.length) return weights;
  const radius = .045, sampleTime = elapsed + .014;
  const cdf = value => {
    const x = Math.max(0, Math.min(1, (value / radius + 1) * .5));
    return x * x * (3 - 2 * x);
  };
  // Find only cues touching the compact kernel. Cost is O(log N + local cues).
  let low = 0, high = cues.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].end <= sampleTime - radius) low = mid + 1; else high = mid;
  }
  for (let index = low; index < cues.length && cues[index].start < sampleTime + radius; index++) {
    const cue = cues[index];
    if (!VALID.has(cue.value)) continue;
    const amount = Math.max(0, cdf(cue.end - sampleTime) - cdf(cue.start - sampleTime));
    weights.X -= amount; weights[cue.value] += amount;
  }
  weights.X = Math.max(0, weights.X);
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  for (const name of MOUTH_SHAPES) weights[name] /= total || 1;
  return weights;
}
