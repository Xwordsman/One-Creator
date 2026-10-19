import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const file = 'deploy/.env';
const content = `# Generated for this instance. Keep this file for backup recovery.\nHOST_PORT=8080\nAPP_ORIGIN=http://localhost:8080\nPOSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nCOOKIE_SECURE=false\n# Optional media service (--profile media); use this value as the video service API key in Settings.\nMEDIA_SERVICE_TOKEN=${randomBytes(24).toString('hex')}\n# Optional executor (--profile executor): paste the node token shown once in 成员与集成 · 执行节点.\nEXECUTOR_TOKEN=\n`;
try {
  await writeFile(file, content, { flag: 'wx', mode: 0o600 });
  console.info(`已创建 ${file}。服务器部署时请将 APP_ORIGIN 改成实际访问地址。`);
  console.info('启动：docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(`${file} 已存在，已保留原配置。`);
    process.exitCode = 1;
  } else throw error;
}
