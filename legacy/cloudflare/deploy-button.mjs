import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = resolve(projectDirectory, 'README.md');
const startMarker = '<!-- deploy-button:start -->';
const endMarker = '<!-- deploy-button:end -->';

function normalizeRepositoryUrl(value) {
  let input = value.trim();
  const scpRemote = input.match(/^git@(github\.com|gitlab\.com):(.+)$/i);
  if (scpRemote) input = `https://${scpRemote[1]}/${scpRemote[2]}`;

  const parsed = new URL(input);
  if (!['https:', 'ssh:'].includes(parsed.protocol)) {
    throw new Error('仓库地址必须使用 HTTPS，或 GitHub / GitLab 的 SSH remote。');
  }
  if (!['github.com', 'gitlab.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Cloudflare 部署按钮需要 github.com 或 gitlab.com 仓库。');
  }
  if (parsed.password || (parsed.username && !(parsed.protocol === 'ssh:' && parsed.username === 'git'))) {
    throw new Error('请提供不含用户名、密码或令牌的仓库地址。');
  }
  if (parsed.port || parsed.search || parsed.hash) {
    throw new Error('请提供仓库根地址，不要附带端口、查询参数或锚点。');
  }

  const repositoryPath = parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '').replace(/^\//, '');
  const segments = repositoryPath.split('/');
  if (
    segments.length < 2 ||
    (parsed.hostname.toLowerCase() === 'github.com' && segments.length !== 2) ||
    segments.some((segment) => !/^[a-zA-Z0-9_.-]+$/.test(segment) || ['.', '..'].includes(segment)) ||
    repositoryPath.toUpperCase() === 'OWNER/REPO'
  ) {
    throw new Error('请提供实际的仓库根地址，例如 https://github.com/your-name/pulsegate。');
  }
  return `https://${parsed.hostname.toLowerCase()}/${repositoryPath}`;
}

try {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length > 1) {
    throw new Error('用法：node scripts/deploy-button.mjs [仓库 URL]');
  }
  let remote = argumentsList[0];
  if (!remote) {
    try {
      remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      throw new Error('未找到 origin remote。请先设置 Git remote，或执行 npm run deploy:button -- https://github.com/your-name/pulsegate。');
    }
  }

  const repositoryUrl = normalizeRepositoryUrl(remote);
  const readme = readFileSync(readmePath, 'utf8');
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start < 0 || end < start || readme.indexOf(startMarker, start + 1) >= 0 || readme.indexOf(endMarker, end + 1) >= 0) {
    throw new Error('README.md 必须包含且仅包含一组 deploy-button 标记。');
  }

  const buttonUrl = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repositoryUrl)}`;
  const buttonBlock = `${startMarker}\n[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${buttonUrl})\n\n> 部署源：[${repositoryUrl.replace('https://', '')}](${repositoryUrl})。请确认仓库已公开，并核对下方的构建与部署命令。\n${endMarker}`;
  writeFileSync(readmePath, `${readme.slice(0, start)}${buttonBlock}${readme.slice(end + endMarker.length)}`, 'utf8');
  console.log(`已更新 README 部署按钮：${repositoryUrl}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
