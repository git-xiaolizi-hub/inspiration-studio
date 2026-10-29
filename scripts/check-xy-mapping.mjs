/**
 * M7b 裁决 1 的护栏：`workflow.css` 里的 `--xy-*` 只准写**纯映射**。
 *
 * 背景：`@xyflow/react` 的配色键（`--xy-*-props`）必须写在组件侧，
 * 否则画布的点阵 / 小地图 / 控制条只能跟着系统偏好走，不跟 `data-theme` 走。
 * 委托方裁决允许这条例外，但**右边必须是 `var(--token)`**：
 *
 *   ✅  --xy-background-color: var(--surface-2);
 *   ❌  --xy-edge-stroke: #8a6f57;               （字面量色）
 *   ❌  --xy-edge-stroke: var(--fg-3, #fff);     （var 里的 fallback 也是字面量）
 *
 * 一旦允许字面量出现在这里，「换主题只改 tokens.css」这条就不成立了 ——
 * 所以这个脚本的存在意义是**让这条边界可执行**，而不是靠代码评审记得。
 *
 * 判据：
 * 1. 文件里每一个 `--xy-*:` 声明的右侧都必须精确匹配 `var(--<token>)`；
 * 2. 注释里的「反例」不算违规（扫描前先剥注释，注释只用来写文档）；
 * 3. 至少存在一条 `--xy-*` 映射（防止有人把整段删掉后脚本空转通过）。
 *
 * 脚本启动时先跑一组自检（.tmp 不放，直接内联字符串）：
 * 故意把「纯映射 / 字面量 / var fallback」三类样本喂给同一个校验函数，
 * 断言结论符合预期 —— 否则一个正则写错的护栏会永远报「通过」。
 *
 * 用法：`npm run check:xy-mapping`
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'src/ui/workflow/workflow.css');

/** 合法右侧：var(--token)，不接受 fallback、不接受任何其它形态 */
const PURE_MAPPING = /^var\(\s*--[a-z0-9-]+\s*\)$/i;

/** 剥掉块注释（保留换行，行号才不会漂） */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ''));
}

/**
 * 从一段 CSS 里找出所有 `--xy-*: <值>` 声明，并标出不合规的。
 * 返回 { total, violations: [{ line, name, value }] }
 */
function scan(css) {
  const text = stripComments(css);
  const declarations = [];
  const pattern = /(^|[\s{;])(--xy-[a-z0-9-]+)\s*:\s*([^;{}]*)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, , name, rawValue] = match;
    const value = rawValue.trim();
    const line = text.slice(0, match.index + match[1].length).split('\n').length;
    declarations.push({ line, name, value });
  }
  const violations = declarations.filter((item) => !PURE_MAPPING.test(item.value));
  return { total: declarations.length, violations };
}

/** 自检：三类样本，结论必须与预期一致，否则护栏本身是坏的 */
const SELF_TEST_CASES = [
  { css: '.a { --xy-background-color: var(--surface-2); }', ok: true, why: '纯映射' },
  { css: '.a { --xy-edge-stroke:var(--fg-3)}', ok: true, why: '无空格也认' },
  { css: '.a { --xy-edge-stroke: #8a6f57; }', ok: false, why: '字面量色必须报错' },
  { css: '.a { --xy-edge-stroke: var(--fg-3, #fff); }', ok: false, why: 'var fallback 也是字面量' },
  { css: '.a { --xy-controls-button-color: rgb(1 2 3); }', ok: false, why: '函数色值必须报错' },
  { css: '/* --xy-edge-stroke: #8a6f57; */\n.a { --xy-edge-stroke: var(--fg-3); }', ok: true, why: '注释里的反例不算违规' },
];

function selfTest() {
  let failed = 0;
  for (const item of SELF_TEST_CASES) {
    const { violations } = scan(item.css);
    const got = violations.length === 0;
    if (got !== item.ok) {
      failed += 1;
      console.error(`  ❌ 自检失败：${item.why} → 期望 ${item.ok ? '通过' : '报错'}，实际 ${got ? '通过' : '报错'}`);
    }
  }
  if (failed > 0) {
    console.error(`\n❌ 护栏自检 ${failed} 条不通过：先修 scripts/check-xy-mapping.mjs 本身。`);
    process.exit(1);
  }
  console.log(`护栏自检通过（${SELF_TEST_CASES.length} 个样本：纯映射 / 字面量 / var fallback / 注释反例）`);
}

selfTest();

if (!existsSync(TARGET)) {
  console.error('❌ 找不到 src/ui/workflow/workflow.css');
  process.exit(1);
}

const { total, violations } = scan(readFileSync(TARGET, 'utf8'));

console.log(`扫描 src/ui/workflow/workflow.css：--xy-* 声明 ${total} 条`);

if (total === 0) {
  console.error('❌ 一条 --xy-* 映射都没有：画布配色会退回 xyflow 的系统偏好默认值。');
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`\n❌ ${violations.length} 条 --xy-* 不是纯映射（右侧必须是 var(--token)）：`);
  for (const item of violations) {
    console.error(`   workflow.css:${item.line}  ${item.name}: ${item.value}`);
  }
  console.error('\n只允许：--xy-<name>: var(--<token>);  —— 颜色值只能出现在 src/ui/tokens.css');
  process.exit(1);
}

console.log(`✅ ${total} 条 --xy-* 全部是 var(--token) 纯映射（0 处字面量色）。`);
