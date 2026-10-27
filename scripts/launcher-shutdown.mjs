// Preloaded only for launcher-owned Node children. No network control surface.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const handled = process.emit('SIGTERM');
  if (process.connected) process.disconnect();
  if (!handled) process.exit(0);
}
process.on('message', message => { if (message?.type === 'air3-launcher-shutdown') shutdown(); });
// A parent crash must not leave an unattended detached gateway/capture behind.
process.on('disconnect', shutdown);
// A completed broadcaster must be able to exit naturally while its parent is
// still watching the gateway. The IPC channel is control, not a keepalive.
process.channel?.unref();
