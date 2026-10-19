import { loadConfig } from '@one-creator/server/config';
import { openDatabase } from '@one-creator/server/database';
import { buildApp } from './app.js';

const config = await loadConfig();
const db = await openDatabase(config);
const app = await buildApp(db, config, { logger: true });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await shutdown();
  throw error;
}
