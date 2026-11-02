/** Actual broadcast player overrides the polled title only for its owned job.
 * Observers retain the public program; operator overrides always win.
 */
export function composeEditorialTitles(program, speech) {
  if (!program?.editorial || program.titleOwner === 'operator' || !speech?.connected) return program?.titles;
  const speaking = speech.phase === 'playing' && speech.editorial || activeResponse(program);
  const ticker = program.titles?.ticker ?? [];
  return { ...program.titles, enabled: !!speaking || ticker.length > 0, ticker,
    label: speaking?.kind === 'chat' ? 'AIR3 CHAT' : 'AIR3 LIVE',
    title: speaking?.title ?? '', subtitle: '', chart:speaking?.chart??null };
}

export function activeResponse(program,now=Date.now()){
 const response=program?.editorial?.activeResponse;
 return response&&response.expiresAt>now&&program.editorial.now>now-5000?response:null;
}
export function conversationFocus(program,speech,now=Date.now()){
 return !!(speech?.connected&&(speech.phase==='playing'&&speech.editorial||activeResponse(program,now)||program?.editorial?.pendingChat&&program.editorial.now>now-5000));
}

// The chart starts at 54%. Reserve room for shoulders/gestures and a gutter;
// shift framing rather than moving the avatar root or changing stage routes.
export function chartCameraOffset(width,chartLeftRatio=.54){
 if(!Number.isFinite(width)||width<1)return 0;
 return width*Math.min(.22,Math.max(0,.5-(chartLeftRatio-.20-.04)));
}

export function presenterFromCurrentPosition(position, yaw) {
  if (!position || ![position.x, position.z, yaw].every(Number.isFinite)) return null;
  return { position: [position.x + Math.sin(yaw) * 2.12, 1.52, position.z + Math.cos(yaw) * 2.12],
    target: [position.x, 1.36, position.z] };
}
