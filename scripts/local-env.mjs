import { chownSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (existsSync('.env')) {
  console.log('.env 已存在，保留现有密钥。');
} else {
  writeFileSync('.env', [
    `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
    `MYSQL_PASSWORD=${randomBytes(24).toString('hex')}`,
    'PORT=8787', 'PUBLIC_URL=', 'DATA_DIR=./data', 'DEV_MODE=false', '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  // Docker's initializer runs as root. Keep the newly created private file
  // readable by the owner of the bind-mounted checkout on Linux hosts.
  if (process.getuid?.() === 0) {
    const owner = statSync('.');
    if (owner.uid !== 0) chownSync('.env', owner.uid, owner.gid);
  }
  console.log('已生成 .env。接下来运行 docker compose up -d --build。');
}
