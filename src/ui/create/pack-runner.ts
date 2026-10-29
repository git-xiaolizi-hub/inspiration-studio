/**
 * 在浏览器里跑 prompt-pack。
 *
 * 为什么不能直接用 `src/packs/runtime.ts`：那个文件顶层 `import { readFileSync } from 'node:fs'`，
 * 它服务于 Node 侧的测试与脚本；**打进浏览器 bundle 会直接炸**（node:fs 被 externalize）。
 * 所以这里做两件事：
 * 1. pack 正文用 Vite 的 `?raw` 在**构建期**内联进来（运行时零网络、断网可用）；
 * 2. 提示词拼接 + JSON 提取 + 校验，按 `runtime.ts` 的同一逻辑重写一遍，
 *    并且**只依赖 `packs/validate.ts` / `packs/frontmatter.ts` 这两个纯函数文件**。
 *
 * 防漂移：`create.test.ts` 里有一条用例，把同一份 SKILL.md 分别交给
 * `packs/runtime.ts` 的 `parsePack` / `buildSystemPrompt` / `buildUserMessage` 和这里的实现，
 * 断言结果**逐字相等**。谁改了其中一边，那条用例立刻红。
 */
import dreamSkillRaw from '../../../packs/dream-interpretation/SKILL.md?raw';
import storySkillRaw from '../../../packs/story-expansion/SKILL.md?raw';
import { parseYamlSubset, splitFrontmatter } from '../../packs/frontmatter';
import type { YamlValue } from '../../packs/frontmatter';
import { validatePackOutput } from '../../packs/validate';
import type { Issue } from '../../packs/validate';
import { withCustomPromptFor } from '../../core/custom-prompts';

export interface BrowserPack {
  name: string;
  description: string;
  io_contract: { input: Record<string, YamlValue>; output: Record<string, YamlValue> };
  validation: string[];
  forbidden: string[];
  body: string;
  sourcePath: string;
}

const REQUIRED_KEYS = ['name', 'description', 'io_contract', 'validation', 'forbidden'] as const;

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

/** 与 `packs/runtime.ts` 的 `parsePack` 同逻辑（缺字段直接抛错，不跑半份 pack） */
export function parsePackText(raw: string, sourcePath = '<bundled>'): BrowserPack {
  const { frontmatter, body } = splitFrontmatter(raw);
  const data = parseYamlSubset(frontmatter);

  const missing = REQUIRED_KEYS.filter((key) => data[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`${sourcePath} 的 frontmatter 缺必填字段：${missing.join(', ')}`);
  }

  const ioContract = asStringMap(data.io_contract, 'io_contract');
  return {
    name: String(data.name),
    description: String(data.description),
    io_contract: {
      input: asStringMap(ioContract.input, 'io_contract.input'),
      output: asStringMap(ioContract.output, 'io_contract.output'),
    },
    validation: asStringList(data.validation, 'validation'),
    forbidden: asStringList(data.forbidden, 'forbidden'),
    body,
    sourcePath,
  };
}

/** 打包进来的两份 pack（正文在构建期内联） */
export const PACK_SOURCES: Record<string, string> = {
  'dream-interpretation': dreamSkillRaw,
  'story-expansion': storySkillRaw,
};

export type CreatePackName = keyof typeof PACK_SOURCES;

export function loadBrowserPack(name: string): BrowserPack {
  const raw = PACK_SOURCES[name];
  if (raw === undefined) throw new Error(`没有打包这份 pack：${name}`);
  // 用户存过自定义副本 → 用副本正文（校验清单/硬禁止仍来自 frontmatter）。
  // 解析函数只有一份（`core/custom-prompts` 的 withCustomPromptFor），画板走同一条路。
  return withCustomPromptFor(parsePackText(raw, `packs/${name}/SKILL.md`), name);
}

export function buildSystemPrompt(pack: BrowserPack): string {
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

export function buildUserMessage(pack: BrowserPack, input: Record<string, unknown>): string {
  const fields = Object.keys(pack.io_contract.input);
  return [
    '输入（JSON）：',
    JSON.stringify(input, null, 2),
    '',
    `输入字段应为：${fields.join(' / ')}。`,
    '按 SKILL 的「输出格式」只返回一个 JSON 对象：不要 Markdown 围栏、不要前后说明、不要注释。',
  ].join('\n');
}

/** 从模型回答里取出 JSON：容忍 ```json 围栏与前后废话，其余报错 */
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

export interface PackPrompt {
  system: string;
  user: string;
}

/**
 * 追问用的 system 提示词（M5a3 §2）。
 *
 * 组成：pack 的 systemPrompt（正文 + 校验清单 + 硬禁止）+ 记录正文，
 * **再加一段"现在是对话"的覆盖说明** —— 否则 pack 里那句「只返回一个 JSON 对象」
 * 会让模型在追问里继续吐 JSON，多轮体验直接崩（实测口径见报告）。
 *
 * 追问**不做** JSON 校验、**不走** `validatePackOutput`：它是发散对话，不是产物。
 */
export function buildFollowUpSystemPrompt(pack: BrowserPack, recordText: string): string {
  return [
    buildSystemPrompt(pack),
    '',
    '【记录正文】',
    recordText,
    '',
    '【现在是追问】',
    '用户会对上面的记录和你的首轮解读继续提问。请用自然语言直接回答这一句：',
    '- 不要输出 JSON、不要套 Markdown 围栏、不要重复首轮的结构化字段；',
    '- 只聊与这段记录相关的内容；不确定就说不确定。',
  ].join('\n');
}

export type PackGenerate = (prompt: PackPrompt) => string | Promise<string>;

export interface PackRunResult {
  output: unknown;
  raw: string;
  issues: Issue[];
}

/**
 * 跑一遍 pack：拼提示 → 交给注入的 generate → 解析 JSON → 机械校验。
 * 解析失败**不抛异常**，转成一条 issue（UI 显示「模型没按格式回答」+ 原文）。
 */
export async function runPackInBrowser(
  pack: BrowserPack,
  input: Record<string, unknown>,
  generate: PackGenerate,
): Promise<PackRunResult> {
  const raw = await generate({
    system: buildSystemPrompt(pack),
    user: buildUserMessage(pack, input),
  });
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
