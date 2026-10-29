/**
 * pack 节点与既有 `runPack` 的桥。
 *
 * 为什么不能直接 `import { runPack } from '../../packs/runtime'`：
 * 那个文件顶层 `import { readFileSync } from 'node:fs'`，打进浏览器 bundle 会直接炸。
 * M5a3 已经为创作页做过同一件事（`src/ui/create/pack-runner.ts`：构建期 `?raw` 内联 +
 * 纯函数提示词拼接）。这里**复用它的导出**，不重写一份：
 *   - `parsePackText` / `runPackInBrowser` 来自 create（同一份实现，有防漂移用例盯着）；
 *   - 唯一新增的是 pack 源表 —— 创作页只内联了 2 份（解梦 / 灵感），
 *     画板要 4 份（多出生图提示词优化、视频分镜）。
 *
 * 输入字段映射（`packInput`）也是"适配"而不是"模板"：各 pack 的 frontmatter
 * 里 `io_contract.input` 的第一个必填字段不同（`dream_text` / `record_text` / `idea`），
 * 这里按 pack 逐条写死，不去猜。
 */

import dreamRaw from '../../../packs/dream-interpretation/SKILL.md?raw';
import storyRaw from '../../../packs/story-expansion/SKILL.md?raw';
import imagePromptRaw from '../../../packs/image-prompt-optimizer/SKILL.md?raw';
import videoStoryboardRaw from '../../../packs/video-storyboard/SKILL.md?raw';
import { parsePackText, runPackInBrowser, buildSystemPrompt } from '../create/pack-runner';
import type { BrowserPack, PackPrompt, PackRunResult } from '../create/pack-runner';
import { hydrateCustomPrompts, withCustomPromptFor } from '../../core/custom-prompts';
import type { PackId } from './types';

const PACK_SOURCES: Record<PackId, { raw: string; path: string }> = {
  'dream-interpretation': {
    raw: dreamRaw,
    path: 'packs/dream-interpretation/SKILL.md',
  },
  'story-expansion': { raw: storyRaw, path: 'packs/story-expansion/SKILL.md' },
  'image-prompt-optimizer': {
    raw: imagePromptRaw,
    path: 'packs/image-prompt-optimizer/SKILL.md',
  },
  'video-storyboard': { raw: videoStoryboardRaw, path: 'packs/video-storyboard/SKILL.md' },
};

const packCache = new Map<PackId, BrowserPack>();

/** 只缓存**解析结果**，不缓存叠加了副本的那一份 —— 副本随时会被改/删 */
function basePack(packId: PackId): BrowserPack {
  const cached = packCache.get(packId);
  if (cached) return cached;
  const source = PACK_SOURCES[packId];
  if (!source) throw new Error(`没有打包这份 pack：${packId}`);
  const pack = parsePackText(source.raw, source.path);
  packCache.set(packId, pack);
  return pack;
}

/**
 * 画板用的 pack：内置解析结果 + 用户副本（只有正文被替换）。
 *
 * 叠加走 `withCustomPromptFor`，与创作页的 `loadBrowserPack` 是**同一个函数**；
 * 这里不缓存叠加结果，否则用户保存副本后画板还会拿到旧正文。
 */
export function loadPackForWorkflow(packId: PackId): BrowserPack {
  return withCustomPromptFor(basePack(packId), packId);
}


/**
 * 上游文本 → pack 的输入对象。
 *
 * 只填**必填字段**，可选字段（context / mood / aspect / dialogue）一律不填 ——
 * 画板只有一个文本入口，替用户编造"情绪"或"画幅"会让 pack 的判据失真。
 */
export function packInput(packId: PackId, text: string): Record<string, unknown> {
  switch (packId) {
    case 'dream-interpretation':
      return { dream_text: text };
    case 'story-expansion':
      return { record_text: text };
    case 'image-prompt-optimizer':
      // target_model 是必填项（frontmatter 里没带 ?）；画板不假设具体厂商，给"通用"口径
      return { idea: text, target_model: '通用图像模型（不指定厂商）' };
    case 'video-storyboard':
      // 分镜的必填参数：镜头数与总时长。画板不做参数面板，给一组保守默认
      return { idea: text, shot_count: 4, total_seconds: 15 };
    default:
      return { text };
  }
}

export type WorkflowGenerate = (prompt: PackPrompt) => string | Promise<string>;

/**
 * 「提示词包」节点要**看得见**的那份全文（M5b2 §4）。
 *
 * 用的就是真正发给模型的 system prompt（正文 + 机器校验清单 + 硬禁止），
 * 不是另写一份说明 —— 否则用户看到的东西和实际跑的东西不是一份东西。
 */
export function packSystemPrompt(packId: PackId): string {
  return buildSystemPrompt(loadPackForWorkflow(packId));
}

/** pack 的输出结构（`io_contract.output` 的字段名） */
export function packOutputFields(packId: PackId): string[] {
  return Object.keys(loadPackForWorkflow(packId).io_contract.output);
}

/** pack 的描述（一句话，画板里当副标题用） */
export function packDescription(packId: PackId): string {
  return loadPackForWorkflow(packId).description;
}

/**
 * 查看/编辑面板要的三段：**内置正文** + 两段机器契约。
 *
 * 只看内置正文（不走副本叠加）：编辑态要能在"副本被改坏"时有东西可对照，
 * 而校验清单与硬禁止本来就永远来自 frontmatter —— 副本动不了它们。
 */
export function packInspectorParts(packId: PackId): {
  builtinBody: string;
  validation: string[];
  forbidden: string[];
} {
  const pack = basePack(packId);
  return {
    builtinBody: pack.body,
    validation: pack.validation,
    forbidden: pack.forbidden,
  };
}

/** 跑一次 pack（单次，无会话） */
export async function runPackNode(
  packId: PackId,
  text: string,
  generate: WorkflowGenerate,
): Promise<PackRunResult> {
  // 副本在 IndexedDB 里：跑之前确保快照已加载，否则"刚存完就去跑"会跑内置正文
  await hydrateCustomPrompts();
  const pack = loadPackForWorkflow(packId);
  return runPackInBrowser(pack, packInput(packId, text), generate);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * pack 的结构化输出 → 给下游节点用的纯文本。
 *
 * 这是"把产物摊平"，不是"重写模板"：每个分支只取 pack 输出里已有的字段。
 * 顺序很重要 —— `positive`（生图提示词）优先，因为 `image-prompt-optimizer` 的下游
 * 通常就是生图节点，取整个 JSON 当提示词会明显变差。
 */
export function packTextFromOutput(_packId: PackId, output: unknown): string {
  const record = asRecord(output);
  if (!record) return '';

  const positive = record.positive;
  if (typeof positive === 'string' && positive.trim() !== '') {
    const negative = record.negative;
    return typeof negative === 'string' && negative.trim() !== ''
      ? `${positive.trim()}\n\n负向提示词：${negative.trim()}`
      : positive.trim();
  }

  const shots = record.shots;
  if (Array.isArray(shots) && shots.length > 0) {
    const lines = shots.map((shot, index) => {
      const item = asRecord(shot);
      const prompt = item?.prompt ?? item?.description ?? '';
      return `${index + 1}. ${String(prompt)}`;
    });
    const sop = record.continuity_sop;
    return typeof sop === 'string' && sop.trim() !== ''
      ? `${lines.join('\n')}\n\n连贯性：${sop.trim()}`
      : lines.join('\n');
  }

  const interpretation = record.interpretation;
  if (typeof interpretation === 'string' && interpretation.trim() !== '') {
    return interpretation.trim();
  }

  const directions = record.directions;
  if (Array.isArray(directions) && directions.length > 0) {
    return directions
      .map((direction, index) => {
        const item = asRecord(direction);
        const title = item?.title ?? `方向 ${index + 1}`;
        const logline = item?.logline ?? '';
        return `${index + 1}. ${String(title)}：${String(logline)}`;
      })
      .join('\n');
  }

  // 兜底：把 JSON 原样给下游（宁可难看，也不要静默丢内容）
  return JSON.stringify(output, null, 2);
}
