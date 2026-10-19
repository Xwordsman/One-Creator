import { loadConfig } from '@one-creator/server/config';
import { openDatabase } from '@one-creator/server/database';
import { startWorker } from '@one-creator/server/jobs';

const config = await loadConfig({ workerMode: 'external' });
const db = await openDatabase(config);
const worker = startWorker(db, config);
console.info('One-Creator worker started');
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await worker.stop();
  await db.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
