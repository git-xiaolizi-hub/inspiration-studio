/**
 * M2.5 从 ModelScope 拉取 whisper 模型到 `public/models/`（模型不进 git，随应用发布）。
 *
 * 为什么是 ModelScope：本机实测 `huggingface.co` / `hf-mirror.com` 均 HTTP 000（不可达），
 * ModelScope 302 / 0.37s 可达；且它**不返回 Access-Control-Allow-Origin**，
 * 浏览器不能直连下载 —— 所以只能构建期下载、作为静态资源一起发布。
 *
 * 用法（npm run model:whisper 即下面这条）：
 *   python scripts/fetch-whisper-model.py --name whisper-base --dest public/models/whisper-base
 *
 * 想省空间可以再拉一份 tiny（44MB，中文明显更差，只作备选）：
 *   python scripts/fetch-whisper-model.py --name whisper-tiny --dest public/models/whisper-tiny
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = pickArg('--name') ?? 'whisper-base';
const dest = pickArg('--dest') ?? `public/models/${name}`;

function pickArg(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** 优先 `python`，其次 Windows 的 `py -3`，再其次 `python3` */
function pythonCommand() {
  const candidates = [
    ['python', ['--version']],
    ['py', ['-3', '--version']],
    ['python3', ['--version']],
  ];
  for (const [command, probeArgs] of candidates) {
    const probe = spawnSync(command, probeArgs, { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) {
      return command === 'py' ? ['py', ['-3']] : [command, []];
    }
  }
  return null;
}

const python = pythonCommand();
if (!python) {
  console.error('❌ 找不到 Python（试过 python / py -3 / python3）。请先安装 Python 3.9+。');
  process.exit(1);
}

const [command, prefix] = python;
const script = resolve(ROOT, 'scripts/fetch-whisper-model.py');
if (!existsSync(script)) {
  console.error(`❌ 缺少下载脚本：${script}`);
  process.exit(1);
}

console.log(`下载 ${name} → ${dest}（源：ModelScope，约 ${name === 'whisper-base' ? 78 : 44}MB）`);
const result = spawnSync(
  command,
  [...prefix, script, '--name', name, '--dest', dest],
  { stdio: 'inherit', cwd: ROOT },
);

if (result.error) {
  console.error(`❌ 执行 Python 失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
