import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '@one-creator/server/config';
import { openDatabase } from '@one-creator/server/database';
import { createBackup, restoreBackup } from '@one-creator/server/backup';

const [command, file] = process.argv.slice(2);
if (!['export', 'restore'].includes(command) || !file) {
  console.error('用法：npm run backup -- export <文件.zip> 或 npm run backup -- restore <文件.zip>');
  process.exitCode = 1;
} else {
  const config = await loadConfig();
  const db = await openDatabase(config);
  try {
    if (command === 'export') {
      await writeFile(path.resolve(file), await createBackup(db, config), { flag: 'wx', mode: 0o600 });
      console.info(`已导出备份：${path.resolve(file)}`);
    } else console.info('恢复完成：', await restoreBackup(db, config, await readFile(path.resolve(file))));
  } finally {
    await db.close();
  }
}
