/**
 * 校验器自身的单测：**喂故意不合规的样例，断言能被抓出来**。
 *
 * 这一组用例存在的唯一理由，是防止校验器退化成「永远返回 true」——
 * 每个用例都先确认「合规样例零 issue」，再做一处破坏，再确认「被抓到」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPack } from './runtime';
import {
  checkPromptLength,
  checkSymbolPairs,
  formatIssues,
  parseOutputContract,
  promptWordCount,
  validatePackOutput,
  validateStoryboard,
} from './validate';
import type { Issue } from './validate';
import { parseTypeSpec } from './frontmatter';

const FIXTURE_ROOT = join(process.cwd(), 'test-fixtures', 'packs');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function codes(issues: Issue[]): string[] {
  return issues.map((issue) => issue.code);
}

function storyboard(): Record<string, unknown> {
  return asRecord(clone(readJson(join(FIXTURE_ROOT, 'video-storyboard', 'response-1.json'))));
}

function firstShot(output: Record<string, unknown>): Record<string, unknown> {
  const shots = asArray(output.shots);
  return asRecord(shots[0]);
}

/* ------------------------------------------------------------------ */
/* 词数                                                                */
/* ------------------------------------------------------------------ */

describe('词数：中文按字数 ×0.6 折算，边界必须严格', () => {
  const ninetyNine = '画'.repeat(99);
  const hundred = '画'.repeat(100);

  it('100 个汉字 = 60.0 词（刚好合规）', () => {
    expect(promptWordCount(hundred)).toBeCloseTo(60, 5);
    expect(checkPromptLength(hundred, 'test')).toEqual([]);
  });

  it('99 个汉字 = 59.4 词（差一点也要报）', () => {
    expect(promptWordCount(ninetyNine)).toBeCloseTo(59.4, 5);
    expect(codes(checkPromptLength(ninetyNine, 'test'))).toContain('prompt-length');
  });

  it('英文按空格分词', () => {
    expect(promptWordCount('a b c')).toBe(3);
  });

  it('超过 150 词会被抓出来', () => {
    const tooLong = `${hundred}，${'光'.repeat(160)}`;
    expect(codes(checkPromptLength(tooLong, 'test'))).toContain('prompt-length');
  });
});

/* ------------------------------------------------------------------ */
/* 符号配对                                                            */
/* ------------------------------------------------------------------ */

describe('四类符号配对', () => {
  it('合规：四类都成对', () => {
    expect(checkSymbolPairs('(钢琴)<罐底>{「走吧？」}【十年后】', 'test')).toEqual([]);
  });

  it('只有左括号没右括号 → 报错', () => {
    expect(codes(checkSymbolPairs('(钢琴 一直响', 'test'))).toContain('symbol-pair');
  });

  it('台词用了全角括号也不算 {} 配对', () => {
    expect(codes(checkSymbolPairs('（「走吧？」）', 'test'))).toContain('symbol-pair');
  });
});

/* ------------------------------------------------------------------ */
/* video-storyboard 的 6 条硬要求的反向验证                            */
/* ------------------------------------------------------------------ */

describe('video-storyboard 校验器：每一处破坏都要被抓到', () => {
  it('基线：fixture 1 零 issue', () => {
    expect(formatIssues(validateStoryboard(storyboard()))).toBe('');
  });

  it('提示词超长（>150 词）→ prompt-length', () => {
    const output = storyboard();
    const shot = firstShot(output);
    shot.prompt = `${String(shot.prompt)}${'。'.repeat(1)}${'灰'.repeat(200)}`;
    expect(codes(validateStoryboard(output))).toContain('prompt-length');
  });

  it('提示词里写了 1080p → param-resolution', () => {
    const output = storyboard();
    const shot = firstShot(output);
    shot.prompt = `${String(shot.prompt)} 以 1080p 输出。`;
    expect(codes(validateStoryboard(output))).toContain('param-resolution');
  });

  it('提示词里写了「竖屏」→ param-orientation', () => {
    const output = storyboard();
    const shot = firstShot(output);
    shot.prompt = `竖屏构图，${String(shot.prompt)}`;
    expect(codes(validateStoryboard(output))).toContain('param-orientation');
  });

  it('关键帧少一张 → keyframe-count', () => {
    const output = storyboard();
    output.keyframes = asArray(output.keyframes).slice(0, -1);
    expect(codes(validateStoryboard(output))).toContain('keyframe-count');
  });

  it('镜头首尾帧挂错了关键帧 → keyframe-first', () => {
    const output = storyboard();
    const shot = asArray(output.shots)[1] as Record<string, unknown>;
    shot.first_keyframe = 'KF1';
    expect(codes(validateStoryboard(output))).toContain('keyframe-first');
  });

  it('锚点块被删空 → anchor-block', () => {
    const output = storyboard();
    output.anchors = [];
    expect(codes(validateStoryboard(output))).toContain('anchor-block');
  });

  it('占位符指向不存在的锚点 → anchor-unknown', () => {
    const output = storyboard();
    const shot = firstShot(output);
    shot.prompt = String(shot.prompt).replace('⟨锚点A⟩', '⟨锚点Z⟩');
    expect(codes(validateStoryboard(output))).toContain('anchor-unknown');
  });

  it('共享帧却不列不变量 → continuity-invariants', () => {
    const output = storyboard();
    const shot = asArray(output.shots)[1] as Record<string, unknown>;
    shot.shared_invariants = [];
    expect(codes(validateStoryboard(output))).toContain('continuity-invariants');
  });

  it('接续 SOP 被删短 → continuity-sop', () => {
    const output = storyboard();
    output.continuity_sop = '按顺序接上。';
    expect(codes(validateStoryboard(output))).toContain('continuity-sop');
  });

  it('参数总时长与各镜之和不一致 → params-total', () => {
    const output = storyboard();
    const params = asRecord(output.params);
    params.total_seconds = 30;
    expect(codes(validateStoryboard(output))).toContain('params-total');
  });

  it('字幕没用【】包裹 → params-subtitles', () => {
    const output = storyboard();
    const params = asRecord(output.params);
    params.subtitles = '十年后';
    expect(codes(validateStoryboard(output))).toContain('params-subtitles');
  });

  it('用空词代替镜头语言 → empty-word', () => {
    const output = storyboard();
    const shot = firstShot(output);
    shot.prompt = `${String(shot.prompt)} 氛围感拉满。`;
    expect(codes(validateStoryboard(output))).toContain('empty-word');
  });

  it('符号不配对 → symbol-pair', () => {
    const output = storyboard();
    const shot = firstShot(output);
    shot.prompt = `${String(shot.prompt)} （钢琴一直响`;
    expect(codes(validateStoryboard(output))).toContain('symbol-pair');
  });

  /**
   * M4d-fix2（证据：`docs/reference/free-e2e-2026-10/video-storyboard.raw.txt`）：
   * 真模型把 `(低沉的钢琴单音)` / `<便利店门铃声>` 写进了 `params.audio.music/sfx`，
   * 提示词正文里这些符号出现 0 次 —— Seedance 只从正文解析音乐与音效，写进 params 等于丢掉。
   */
  it('params.audio 只写元信息（环境声开 / 无配乐）→ 不报 symbol-misplaced', () => {
    const output = storyboard();
    const params = asRecord(output.params);
    params.audio = { ambience: '环境声开', has_music: false, dialogue_lines: 1 };
    expect(codes(validateStoryboard(output))).not.toContain('symbol-misplaced');
    expect(formatIssues(validateStoryboard(output))).toBe('');
  });

  it('把 (钢琴) 塞进 params.audio.music → symbol-misplaced', () => {
    const output = storyboard();
    const params = asRecord(output.params);
    params.audio = { music: '(钢琴)', sfx: '<罐底碰台面>', dialogue_lines: 1 };
    const issues = validateStoryboard(output);
    expect(codes(issues)).toContain('symbol-misplaced');
    const misplaced = issues.filter((issue) => issue.code === 'symbol-misplaced');
    expect(misplaced.map((issue) => issue.where)).toEqual([
      'params.audio.music',
      'params.audio.sfx',
    ]);
    expect(misplaced[0].message).toContain('提示词正文');
  });
});

/* ------------------------------------------------------------------ */
/* 必填 JSON 字段                                                      */
/* ------------------------------------------------------------------ */

describe('必填字段：按 io_contract 的类型表达式判定', () => {
  const pack = loadPack('video-storyboard');

  it('缺 continuity_sop → field-missing', () => {
    const output = storyboard();
    delete output.continuity_sop;
    expect(codes(validatePackOutput(pack, output))).toContain('field-missing');
  });

  it('shots 不是数组 → field-type', () => {
    const output = storyboard();
    output.shots = '五镜';
    expect(codes(validatePackOutput(pack, output))).toContain('field-type');
  });

  it('io_contract 的 output 字段能被解析成类型（不是一堆字符串）', () => {
    const spec = parseTypeSpec(String(Object.values(pack.io_contract.output).join(',')));
    expect(spec.kind).toBe('unknown');
    const anchorsSpec = parseOutputContract(pack.io_contract.output.anchors);
    expect(anchorsSpec.kind).toBe('array');
  });
});

/* ------------------------------------------------------------------ */
/* 另外三个 pack 的专用规则                                             */
/* ------------------------------------------------------------------ */

describe('dream-interpretation：编造文献与原文外的意象都要被抓', () => {
  const pack = loadPack('dream-interpretation');
  const input = asRecord(readJson(join(FIXTURE_ROOT, 'dream-interpretation', 'input-1.json')));
  const response = readJson(join(FIXTURE_ROOT, 'dream-interpretation', 'response-1.json'));

  it('基线：合规 fixture 零 issue', () => {
    expect(formatIssues(validatePackOutput(pack, clone(response), input))).toBe('');
  });

  it('补一句「据《梦的解析》第 47 页」→ dream-citation', () => {
    const output = asRecord(clone(response));
    output.interpretation = `${String(output.interpretation)}据《梦的解析》第 47 页。`;
    expect(codes(validatePackOutput(pack, output, input))).toContain('dream-citation');
  });

  it('symbols 里塞入原文没有的意象 → dream-symbol-source', () => {
    const output = asRecord(clone(response));
    const symbols = asArray(output.symbols).map(asRecord);
    symbols[0].symbol = '一只黑猫';
    output.symbols = symbols;
    expect(codes(validatePackOutput(pack, output, input))).toContain('dream-symbol-source');
  });

  it('symbols 少于 3 项 → dream-symbols-count', () => {
    const output = asRecord(clone(response));
    output.symbols = asArray(output.symbols).slice(0, 2);
    expect(codes(validatePackOutput(pack, output, input))).toContain('dream-symbols-count');
  });
});

describe('story-expansion：冲突源重复与套路句都要被抓', () => {
  const pack = loadPack('story-expansion');
  const input = asRecord(readJson(join(FIXTURE_ROOT, 'story-expansion', 'input-1.json')));
  const response = readJson(join(FIXTURE_ROOT, 'story-expansion', 'response-1.json'));

  it('基线：合规 fixture 零 issue', () => {
    expect(formatIssues(validatePackOutput(pack, clone(response), input))).toBe('');
  });

  it('两个方向用了同一个冲突源 → story-conflict-duplicate', () => {
    const output = asRecord(clone(response));
    const directions = asArray(output.directions).map(asRecord);
    directions[1].conflict = '人与人：他和另一个邻居';
    output.directions = directions;
    expect(codes(validatePackOutput(pack, output, input))).toContain('story-conflict-duplicate');
  });

  it('logline 写成「命运的齿轮开始转动」→ story-cliche', () => {
    const output = asRecord(clone(response));
    const directions = asArray(output.directions).map(asRecord);
    directions[0].logline = '命运的齿轮开始转动。';
    output.directions = directions;
    expect(codes(validatePackOutput(pack, output, input))).toContain('story-cliche');
  });

  it('beats 里写心理而不是动作 → story-beat-mental', () => {
    const output = asRecord(clone(response));
    const directions = asArray(output.directions).map(asRecord);
    directions[0].beats = ['他感到一阵空。', '他站起来。', '他关灯。'];
    output.directions = directions;
    expect(codes(validatePackOutput(pack, output, input))).toContain('story-beat-mental');
  });

  it('why_it_holds 不引用记录里的词 → story-why-source', () => {
    const output = asRecord(clone(response));
    const directions = asArray(output.directions).map(asRecord);
    directions[0].why_it_holds = '因为这个设定本身就很有张力。';
    output.directions = directions;
    expect(codes(validatePackOutput(pack, output, input))).toContain('story-why-source');
  });
});

describe('image-prompt-optimizer：五要素与参数分离', () => {
  const pack = loadPack('image-prompt-optimizer');
  const response = readJson(join(FIXTURE_ROOT, 'image-prompt-optimizer', 'response-1.json'));

  it('基线：合规 fixture 零 issue', () => {
    expect(formatIssues(validatePackOutput(pack, clone(response), {}))).toBe('');
  });

  it('elements 缺 style → image-element-missing', () => {
    const output = asRecord(clone(response));
    const elements = asRecord(output.elements);
    delete elements.style;
    output.elements = elements;
    expect(codes(validatePackOutput(pack, output, {}))).toContain('image-element-missing');
  });

  it('positive 里写「9:16」→ image-param-in-positive', () => {
    const output = asRecord(clone(response));
    output.positive = `${String(output.positive)} 9:16。`;
    expect(codes(validatePackOutput(pack, output, {}))).toContain('image-param-in-positive');
  });

  it('positive 里写「1080p」→ image-param-in-positive', () => {
    const output = asRecord(clone(response));
    output.positive = `${String(output.positive)} 1080p 出图。`;
    expect(codes(validatePackOutput(pack, output, {}))).toContain('image-param-in-positive');
  });

  it('aspect 与 size 不自洽 → image-param-mismatch', () => {
    const output = asRecord(clone(response));
    const params = asRecord(output.params);
    params.aspect_ratio = '16:9';
    output.params = params;
    expect(codes(validatePackOutput(pack, output, {}))).toContain('image-param-mismatch');
  });

  it('positive 堆空词 → empty-word', () => {
    const output = asRecord(clone(response));
    output.positive = `${String(output.positive)} 绝美，史诗级。`;
    expect(codes(validatePackOutput(pack, output, {}))).toContain('empty-word');
  });

  /**
   * M4d 零成本真实自检（`M4d-free-e2e.md`）：真模型给的 params 就是
   * `{model, aspect_ratio, size, count}`——没有 notes，却被契约判 `field-missing`。
   * notes 是辅助备注，设成必填只会制造无意义的失败 → 已改为可选。
   */
  it('params 不带 notes 也合格（真模型的实际输出形态）', () => {
    const output = asRecord(clone(response));
    const params = asRecord(output.params);
    delete params.notes;
    output.params = params;

    expect(Object.keys(params)).toEqual(['model', 'aspect_ratio', 'size', 'count']);
    expect(formatIssues(validatePackOutput(pack, output, {}))).toBe('');
  });

  it('params 带 notes 同样合格（可选字段不能反过来卡住）', () => {
    const output = asRecord(clone(response));
    const params = asRecord(output.params);
    params.notes = '该模型没有负向入口，负面要求写进正面描述';
    output.params = params;

    expect(formatIssues(validatePackOutput(pack, output, {}))).toBe('');
  });
});
