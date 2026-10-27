/** Interactive quit and explicitly supervised stdin, without stopping services
 * whose stdin is /dev/null (the normal systemd/container configuration). */
export function attachStdinControl(input, controller, { supervised = false } = {}) {
  if (!supervised && !input.isTTY) return () => {};
  let buffer = '';
  const onData = (chunk) => {
    buffer = (buffer + String(chunk)).slice(-512);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const command = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (command === 'quit') controller.abort();
    }
  };
  const onEnd = () => { if (supervised) controller.abort(); };
  input.on('data', onData); input.on('end', onEnd); input.resume();
  return () => { input.removeListener('data', onData); input.removeListener('end', onEnd); input.pause(); };
}
