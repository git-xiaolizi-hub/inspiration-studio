/**
 * prompt-pack 的加载与运行外壳。
 *
 * 三层分离（这是本轮的取舍，见 M4-REPORT.md §3）：
 *   1. `packs/<name>/SKILL.md` —— 内容，人可读、可改、可版本化，**不硬编码进 src**；
 *   2. `runtime.ts` —— 把 pack 变成一次调用的输入（system + user），并把模型输出还原成 JSON；
 *   3. `validate.ts` —— 对 JSON 做机械校验。
 *
 * 本轮**不做真实调用**：`runPack` 的 `generate` 由调用方注入，测试里注入的是 fixture 里的
 * 假模型响应（CHARTER §13.2 成本纪律）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { YamlValue } from './frontmatter';
import { parseYamlSubset, splitFrontmatter } from './frontmatter';
import type { Issue } from './validate';
import { validatePackOutput } from './validate';

/**
 * 仓库根下的 `packs/`。
 *
 * 注意：vitest 在 jsdom 环境里会把 `import.meta.url` 改写成 `http://localhost/...`，
 * 直接 `fileURLToPath` 会抛「URL must be of scheme file」。所以 file: 用不了时退回
 * `process.cwd()`（vitest / node 脚本都从仓库根跑）。
 */
function resolvePacksRoot(): string {
  if (import.meta.url.startsWith('file:')) {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs');
  }
  if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
    return join(process.cwd(), 'packs');
  }
  throw new Error('无法定位 packs/ 目录（既不是 file: URL，也没有 process.cwd）');
}

export const PACKS_ROOT = resolvePacksRoot();

export interface Pack {
  name: string;
  description: string;
  io_contract: { input: Record<string, YamlValue>; output: Record<string, YamlValue> };
  validation: string[];
  forbidden: string[];
  /** 视频类额外字段（anchors / keyframe_mode / output_includes 等），保持原样 */
  extra: Record<string, YamlValue>;
  body: string;
  sourcePath: string;
}

const REQUIRED_KEYS = ['name', 'description', 'io_contract', 'validation', 'forbidden'] as const;
const REQUIRED_SECTIONS = ['# 角色', '# 输入契约', '# 输出格式', '# 判据', '# 禁止项'];

function asStringList(value: YamlValue | undefined, key: string): string[] {
  if (!Array.isArray(value)) throw new Error(`frontmatter.${key} 必须是列表`);
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`frontmatter.${key} 的列表项必须是字符串`);
    return item;
  });
}

function asStringMap(value: YamlValue | undefined, key: string): Record<string, YamlValue> {
  if (typeof value !== 'object' || Array.isArray(value) || value === null) {
    throw new Error(`frontmatter.${key} 必须是映射`);
  }
  return value;
}

/** 解析一份 pack；缺必填字段直接抛错（宁可报错也不静默跑半份 pack） */
export function parsePack(raw: string, sourcePath = '<memory>'): Pack {
  const { frontmatter, body } = splitFrontmatter(raw);
  const data = parseYamlSubset(frontmatter);

  const missing = REQUIRED_KEYS.filter((key) => data[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`${sourcePath} 的 frontmatter 缺必填字段：${missing.join(', ')}`);
  }

  const ioContract = asStringMap(data.io_contract, 'io_contract');
  const pack: Pack = {
    name: String(data.name),
    description: String(data.description),
    io_contract: {
      input: asStringMap(ioContract.input, 'io_contract.input'),
      output: asStringMap(ioContract.output, 'io_contract.output'),
    },
    validation: asStringList(data.validation, 'validation'),
    forbidden: asStringList(data.forbidden, 'forbidden'),
    extra: {},
    body,
    sourcePath,
  };

  for (const [key, value] of Object.entries(data)) {
    if (!REQUIRED_KEYS.includes(key as (typeof REQUIRED_KEYS)[number])) {
      pack.extra[key] = value;
    }
  }
  return pack;
}

export function packNames(): string[] {
  if (!existsSync(PACKS_ROOT)) return [];
  return readdirSync(PACKS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadPack(name: string): Pack {
  const path = join(PACKS_ROOT, name, 'SKILL.md');
  if (!existsSync(path)) throw new Error(`找不到 pack：${path}`);
  return parsePack(readFileSync(path, 'utf8'), path);
}

/** pack 自身的结构检查（供测试断言「四个 pack 都合格」） */
export function checkPackStructure(pack: Pack): Issue[] {
  const issues: Issue[] = [];
  for (const section of REQUIRED_SECTIONS) {
    if (!pack.body.includes(section)) {
      issues.push({
        code: 'pack-section',
        where: pack.name,
        message: `正文缺小节「${section}」`,
      });
    }
  }
  if (pack.validation.length === 0) {
    issues.push({ code: 'pack-validation', where: pack.name, message: 'validation 为空' });
  }
  if (pack.forbidden.length === 0) {
    issues.push({ code: 'pack-forbidden', where: pack.name, message: 'forbidden 为空' });
  }
  if (pack.body.includes('npx skills@latest update') || pack.body.includes('npx --yes skills@latest')) {
    issues.push({
      code: 'pack-self-upgrade',
      where: pack.name,
      message: '正文残留自升级段（npx skills@latest update）—— 必须删除',
    });
  }
  return issues;
}

/**
 * 交给模型的 system 提示：pack 正文 + frontmatter 里的机器校验清单。
 *
 * 正文讲「怎么想」，frontmatter 的 validation/forbidden 是**会被程序逐条判定的硬条款**，
 * 必须一起给模型看，否则它不知道哪些话会被直接打回。
 */
export function buildSystemPrompt(pack: Pack): string {
  return [
    pack.body,
    '',
    '## 机器校验清单（输出会被逐条校验，任何一条不满足即视为不合格）',
    ...pack.validation.map((rule) => `- ${rule}`),
    '',
    '## 硬禁止（校验器会直接判定为不合格）',
    ...pack.forbidden.map((rule) => `- ${rule}`),
  ].join('\n');
}

/** 交给模型的 user 消息：输入数据 + 只输出 JSON 的硬要求 */
export function buildUserMessage(pack: Pack, input: Record<string, unknown>): string {
  const fields = Object.keys(pack.io_contract.input);
  return [
    '输入（JSON）：',
    JSON.stringify(input, null, 2),
    '',
    `输入字段应为：${fields.join(' / ')}。`,
    '按 SKILL 的「输出格式」只返回一个 JSON 对象：不要 Markdown 围栏、不要前后说明、不要注释。',
  ].join('\n');
}

/** 从模型回答里取出 JSON：容忍 ```json 围栏与前后废话，其余一律报错 */
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`回答里找不到 JSON 对象：${text.slice(0, 80)}…`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export interface GenerateInput {
  system: string;
  user: string;
}

export type Generate = (prompt: GenerateInput) => string | Promise<string>;

export interface PackRunResult {
  output: unknown;
  raw: string;
  issues: Issue[];
}

/**
 * 跑一遍 pack：拼提示 → 交给注入的 generate → 解析 JSON → 机械校验。
 * 解析失败不抛异常，转成一条 issue，方便 UI 显示「模型没按格式回答」。
 */
export async function runPack(
  pack: Pack,
  input: Record<string, unknown>,
  generate: Generate,
): Promise<PackRunResult> {
  const prompt: GenerateInput = {
    system: buildSystemPrompt(pack),
    user: buildUserMessage(pack, input),
  };
  const raw = await generate(prompt);
  let output: unknown;
  try {
    output = extractJson(raw);
  } catch (error) {
    return {
      output: null,
      raw,
      issues: [
        {
          code: 'json-parse',
          where: pack.name,
          message: `输出不是可解析的 JSON：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return { output, raw, issues: validatePackOutput(pack, output, input) };
}
