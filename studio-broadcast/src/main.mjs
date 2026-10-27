import { loadConfig } from './config.mjs';
import { createGateway } from './gateway.mjs';

const config = loadConfig();
const gateway = await createGateway(config);
gateway.server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'gateway-listening', host: config.host, port: config.port }));
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 45000).unref();
  try { await gateway.close(); clearTimeout(timer); } catch { process.exitCode = 1; }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
