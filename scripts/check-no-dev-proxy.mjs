/**
 * M3R10 §5-6 的判据脚本：**构建产物里不能有 dev 代理的痕迹**。
 *
 * 为什么不是一个裸 `grep -r dist/ __px`：
 * `dist/models/whisper-base/onnx/*.onnx` 是 23MB 的**二进制权重**，它的随机字节里
 * 会偶然出现 `__px` 这 4 个字节（实测 2 处，周围全是不可打印字节）。
 * 拿裸 grep 当判据会得到「1 命中」，然后被迫去解释一个与代码无关的巧合 ——
 * 判据该盯的是**打包器产出的文本产物**：JS / CSS / HTML。那里命中才是泄漏。
 *
 * 判据（全部必须成立）：
 * 1. 文本产物里 `__px` 命中数 = 0；
 * 2. 两个挂载名 `/__px/ark`、`/__px/linghui` 命中数 = 0；
 * 3. 改写函数的符号名命中数 = 0（证明整段代码被摇掉，不只是字符串被替换）。
 *
 * 用法：`npm run check:no-dev-proxy`（读取 dist/，需先 build）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** 判据只认这些扩展名：打包器写出的文本产物 */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.map', '.json', '.svg', '.txt']);

/** 不许出现的针（`__px` 是前缀，另两个是挂载名，最后两个是符号名） */
const NEEDLES = ['__px', '/__px/ark', '/__px/linghui', 'rewriteForDevProxy', 'devProxyRewrite'];

if (!existsSync(DIST)) {
  console.error('❌ 找不到 dist/ —— 先跑 `npm run build`');
  process.exit(1);
}

/** 递归收集**文本**产物（跳过 .onnx / .wasm 这类二进制） */
function collectTextFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...collectTextFiles(full));
      continue;
    }
    if (TEXT_EXTENSIONS.has(extname(entry).toLowerCase())) out.push(full);
  }
  return out;
}

const textFiles = collectTextFiles(DIST);
const hits = [];

for (const needle of NEEDLES) {
  for (const file of textFiles) {
    const content = readFileSync(file, 'utf8');
    const count = content.split(needle).length - 1;
    if (count > 0) {
      hits.push({ needle, file: file.slice(ROOT.length + 1), count });
    }
  }
}

console.log(`扫描 ${textFiles.length} 个文本产物（跳过 .onnx / .wasm 等二进制）：`);
for (const needle of NEEDLES) {
  const total = hits
    .filter((hit) => hit.needle === needle)
    .reduce((sum, hit) => sum + hit.count, 0);
  console.log(`  ${needle.padEnd(20)} → ${total}`);
}

if (hits.length > 0) {
  console.error('\n❌ dev 代理泄漏到生产产物：');
  for (const hit of hits) console.error(`   ${hit.file}: ${hit.needle} × ${hit.count}`);
  process.exit(1);
}

console.log('\n✅ 0 命中：dev 代理没有泄漏到生产产物（M3R10 §5-6）。');
