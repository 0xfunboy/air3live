// New leases distinguish a producer's deliberate emotion from the legacy
// neutral placeholder. Older players/leases without the flag retain their
// existing behaviour. The operator's current choice resumes outside playback.
export function resolvePresenterEmotion(state, fallback) {
  return state?.phase === 'playing' && state.emotion && state.emotionExplicit !== false
    ? state.emotion
    : fallback;
}
