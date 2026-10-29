/**
 * prompt-pack 的端到端用例（`npm run test:packs`）。
 *
 * 纪律：**不调用任何真实模型**。每个 pack 用 3 条固定假输入跑一遍，
 * 模型响应是 fixture 里预置的（`test-fixtures/packs/<name>/response-N.json`），
 * 由注入的 `generate` 直接返回（CHARTER §13.2 成本纪律）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildUserMessage,
  checkPackStructure,
  loadPack,
  PACKS_ROOT,
  packNames,
  runPack,
} from './runtime';
import type { Pack } from './runtime';
import {
  checkAnchorPlaceholders,
  checkKeyframePairing,
  checkParamSeparation,
  checkSymbolPairs,
  formatIssues,
  promptWordCount,
  validateStoryboard,
} from './validate';

const FIXTURE_ROOT = join(process.cwd(), 'test-fixtures', 'packs');

const PACK_NAMES = [
  'dream-interpretation',
  'story-expansion',
  'image-prompt-optimizer',
  'video-storyboard',
] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 三种回答形态都要能被解析：围栏 / 裸 JSON / 带前言 */
function wrapResponse(index: number, payload: unknown): string {
  const json = JSON.stringify(payload, null, 2);
  if (index === 1) return `\`\`\`json\n${json}\n\`\`\``;
  if (index === 2) return json;
  return `以下是结果，请查收：\n\n${json}\n\n（已按判据自检）`;
}

describe('pack 目录与 packs/ 一致（内容不硬编码进 src）', () => {
  it('packs/ 下正好是约定的 4 个 pack', () => {
    expect(packNames()).toEqual([...PACK_NAMES].sort());
  });

  it.each(PACK_NAMES)('%s 的 frontmatter 必填字段与正文小节齐全', (name) => {
    const pack = loadPack(name);
    expect(pack.name).toBe(name);
    expect(formatIssues(checkPackStructure(pack))).toBe('');
    expect(pack.validation.length).toBeGreaterThan(0);
    expect(pack.forbidden.length).toBeGreaterThan(0);
    expect(Object.keys(pack.io_contract.input).length).toBeGreaterThan(0);
    expect(Object.keys(pack.io_contract.output).length).toBeGreaterThan(0);
  });

  it('四个 pack 都没有残留官方 sd25-pe 的自升级段', () => {
    for (const name of PACK_NAMES) {
      const raw = readFileSync(join(PACKS_ROOT, name, 'SKILL.md'), 'utf8');
      expect(raw).not.toContain('npx skills@latest update');
      expect(raw).not.toContain('npx --yes skills@latest');
      expect(raw).not.toContain('skills@latest');
    }
  });
});

describe.each(PACK_NAMES)('%s：3 条固定输入跑通（注入假模型响应）', (name) => {
  const pack: Pack = loadPack(name);

  it.each([1, 2, 3])('第 %i 条输入：拼出的提示 + 假响应 + 机械校验全部通过', async (index) => {
    const input = asRecord(readJson(join(FIXTURE_ROOT, name, `input-${index}.json`)));
    const response = readJson(join(FIXTURE_ROOT, name, `response-${index}.json`));

    let systemPrompt = '';
    let userPrompt = '';
    const result = await runPack(pack, input, (prompt) => {
      systemPrompt = prompt.system;
      userPrompt = prompt.user;
      return wrapResponse(index, response);
    });

    expect(formatIssues(result.issues)).toBe('');

    // 拼出来的提示里必须有判据与禁止项，否则模型看不到硬要求
    expect(systemPrompt).toContain('# 判据');
    expect(systemPrompt).toContain('# 禁止项');
    for (const rule of pack.validation.slice(0, 3)) {
      expect(systemPrompt).toContain(rule);
    }
    // user 消息必须把输入原样带过去
    for (const value of Object.values(input)) {
      expect(userPrompt).toContain(JSON.stringify(value));
    }
    expect(userPrompt).toBe(buildUserMessage(pack, input));

    // 必填字段真的存在（不是靠校验器兜住的空对象）
    const output = asRecord(result.output);
    for (const key of Object.keys(pack.io_contract.output)) {
      expect(output[key]).toBeDefined();
    }
  });

  it('模型跑偏（回答不是 JSON）时给出 issue 而不是抛异常', async () => {
    const input = asRecord(readJson(join(FIXTURE_ROOT, name, 'input-1.json')));
    const result = await runPack(pack, input, () => '抱歉，我无法完成这个请求。');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('json-parse');
  });
});

describe('video-storyboard：6 条硬要求逐条校验（fixture 1）', () => {
  const raw = readJson(join(FIXTURE_ROOT, 'video-storyboard', 'response-1.json'));
  const output = asRecord(raw);
  const anchors = asArray(output.anchors).map(asRecord);
  const keyframes = asArray(output.keyframes).map(asRecord);
  const shots = asArray(output.shots).map(asRecord);

  it('① 含锚点块：每个角色/场景一段固定文本，且被占位符引用', () => {
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    expect(anchors.some((anchor) => anchor.kind === 'character')).toBe(true);
    expect(anchors.some((anchor) => anchor.kind === 'scene')).toBe(true);
    for (const anchor of anchors) {
      expect(str(anchor.text).length).toBeGreaterThanOrEqual(20);
    }
    const prompts = shots.map((shot) => str(shot.prompt));
    const ids = anchors.map((anchor) => str(anchor.id));
    expect(formatIssues(checkAnchorPlaceholders(prompts, ids))).toBe('');
  });

  it('② 首尾帧成对：N+1 张关键帧 → N 个镜头', () => {
    expect(keyframes.length).toBe(shots.length + 1);
    expect(formatIssues(checkKeyframePairing(keyframes, shots))).toBe('');
    expect(shots[0].first_keyframe).toBe('KF1');
    expect(shots[shots.length - 1].last_keyframe).toBe(`KF${keyframes.length}`);
  });

  it('③ 每镜提示词 60–150 词（中文按字数 ×0.6 折算）', () => {
    for (const shot of shots) {
      const count = promptWordCount(str(shot.prompt));
      expect(count).toBeGreaterThanOrEqual(60);
      expect(count).toBeLessThanOrEqual(150);
    }
  });

  it('④ 无参数污染：不出现「15 秒 / 竖屏 / 1080p / 24fps」', () => {
    for (const shot of shots) {
      const prompt = str(shot.prompt);
      expect(prompt).not.toMatch(/15\s*秒|竖屏|1080p|24\s*fps/i);
      expect(formatIssues(checkParamSeparation(prompt, 'shot'))).toBe('');
    }
    // 参数必须真的单列在 params 里（不是直接删掉）
    const params = asRecord(output.params);
    expect(params.aspect).toBe('9:16');
    expect(params.fps).toBe(24);
    expect(asArray(params.shot_seconds)).toHaveLength(shots.length);
  });

  it('⑤ 含首尾帧接续 SOP 文本块，且区分共享帧与跳切', () => {
    const sop = str(output.continuity_sop);
    expect(sop.length).toBeGreaterThanOrEqual(100);
    expect(sop).toContain('真实末帧');
    expect(sop).toContain('共享帧');
    expect(sop).toContain('跳切');
    const types = shots.map((shot) => str(asRecord(shot.continuity).type));
    expect(new Set(types)).toEqual(new Set(['opening', 'shared_frame', 'jump_cut']));
  });

  it('⑥ 四类符号成对：音乐 ()、音效 <>、台词 {}、字幕 【】', () => {
    for (const shot of shots) {
      expect(formatIssues(checkSymbolPairs(str(shot.prompt), 'shot'))).toBe('');
    }
    const joined = shots.map((shot) => str(shot.prompt)).join('\n');
    expect(joined).toMatch(/\([^)]+\)/);
    expect(joined).toMatch(/<[^>]+>/);
    expect(joined).toMatch(/\{[^}]+\}/);
    expect(str(asRecord(output.params).subtitles)).toMatch(/^【.+】$/);
  });

  it('整体校验器对合规样例零 issue（防止「永远返回 true」的反向验证）', () => {
    expect(formatIssues(validateStoryboard(raw))).toBe('');
  });
});
