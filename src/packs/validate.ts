/**
 * prompt-pack 的机械校验器。
 *
 * 定位：把官方 Seedance 2.5 提示词规范里「输出前自检清单」中**能机械判定**的部分
 * 落成函数。判不了的不假装判（见 M4-REPORT.md §4 的清单）。
 *
 * 一条纪律：**校验器不许永远返回 true**。`validate.test.ts` 里专门喂了不合规样例
 * （超 150 词、带 1080p、关键帧数不对、符号不配对、缺字段），断言必须被抓出来。
 */
import type { YamlValue } from './frontmatter';
import { parseTypeSpec, splitTopLevel } from './frontmatter';
import type { TypeSpec } from './frontmatter';

export interface Issue {
  code: string;
  message: string;
  where?: string;
}

/* ------------------------------------------------------------------ */
/* 1. 词数（英文按空格分词；中文按字数 × 0.6 折算）                     */
/* ------------------------------------------------------------------ */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/** 与 CHARTER §2 M4 的口径一致：中文按字数 ×0.6 折算成「词」 */
export function promptWordCount(text: string): number {
  const cjkChars = Array.from(text).filter((char) => CJK.test(char)).length;
  const rest = text.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g, ' ');
  const latinWords = rest.split(/[^A-Za-z0-9]+/).filter((word) => word !== '').length;
  return Math.round((cjkChars * 0.6 + latinWords) * 10) / 10;
}

export function checkPromptLength(
  text: string,
  where: string,
  min = 60,
  max = 150,
): Issue[] {
  const count = promptWordCount(text);
  if (count < min || count > max) {
    return [
      {
        code: 'prompt-length',
        where,
        message: `提示词 ${count} 词，超出 ${min}–${max} 词区间（中文按字数 ×0.6 折算）`,
      },
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 2. 参数污染（参数必须单列，不许进提示词正文）                        */
/* ------------------------------------------------------------------ */

interface PollutionRule {
  code: string;
  label: string;
  pattern: RegExp;
}

export const PARAM_POLLUTION_RULES: PollutionRule[] = [
  { code: 'param-duration', label: '时长', pattern: /\d+\s*(秒|s\b|秒钟)/i },
  { code: 'param-fps', label: '帧率', pattern: /\d+\s*(fps|帧每秒|帧\s*\/\s*秒)/i },
  {
    code: 'param-resolution',
    label: '分辨率',
    pattern: /\b\d{3,4}\s*[x×]\s*\d{3,4}\b|(480p|720p|1080p|2k|4k)\b/i,
  },
  { code: 'param-aspect', label: '画幅比例', pattern: /\b\d{1,2}\s*[:：]\s*\d{1,2}\b/ },
  { code: 'param-orientation', label: '横竖屏', pattern: /竖屏|横屏|画幅|画面比例/ },
  { code: 'param-word', label: '参数词', pattern: /分辨率|总时长|单镜时长|时长为/ },
  { code: 'param-split-screen', label: '分屏构图', pattern: /分屏|画面一分为二|左右对比构图/ },
];

export function checkParamSeparation(text: string, where: string): Issue[] {
  const issues: Issue[] = [];
  for (const rule of PARAM_POLLUTION_RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      issues.push({
        code: rule.code,
        where,
        message: `提示词正文出现${rule.label}参数「${match[0]}」——参数必须单列，不许进正文`,
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* 3. 空词（用空词代替镜头语言 / 用形容词代替描述）                     */
/* ------------------------------------------------------------------ */

export const EMPTY_WORDS = [
  '氛围感',
  '大片感',
  '电影感',
  '史诗感',
  '史诗级',
  '高级感',
  '绝美',
  '震撼',
  '极致',
  '超高清',
  '氛围拉满',
  '8k',
  'masterpiece',
  'best quality',
  'award-winning',
  'award winning',
];

export function checkEmptyWords(text: string, where: string): Issue[] {
  const lower = text.toLowerCase();
  return EMPTY_WORDS.filter((word) => lower.includes(word.toLowerCase())).map((word) => ({
    code: 'empty-word',
    where,
    message: `出现空词「${word}」——换成可执行的镜头/材质描述`,
  }));
}

/* ------------------------------------------------------------------ */
/* 4. 四类符号配对：音乐 ()、音效 <>、台词 {}、字幕 【】                */
/* ------------------------------------------------------------------ */

const SYMBOL_PAIRS: { name: string; open: string; close: string }[] = [
  { name: '音乐 ()', open: '(', close: ')' },
  { name: '音效 <>', open: '<', close: '>' },
  { name: '台词 {}', open: '{', close: '}' },
  { name: '字幕 【】', open: '【', close: '】' },
];

function countChar(text: string, char: string): number {
  return Array.from(text).filter((item) => item === char).length;
}

export function checkSymbolPairs(text: string, where: string): Issue[] {
  const issues: Issue[] = SYMBOL_PAIRS.filter(
    (pair) => countChar(text, pair.open) !== countChar(text, pair.close),
  ).map((pair) => ({
    code: 'symbol-pair',
    where,
    message: `${pair.name} 没有成对：${countChar(text, pair.open)} 个左符号 / ${countChar(
      text,
      pair.close,
    )} 个右符号`,
  }));

  // 全角括号不是合法形式：`（音乐）` 会被当成「没有音乐标记」，必须显式报错
  if (/[（）]/.test(text)) {
    issues.push({
      code: 'symbol-pair',
      where,
      message: '音乐标记必须用半角 ()，不要用全角 （）',
    });
  }
  return issues;
}

/** 全片至少各用一次 ()、<>、{}；【】允许只出现在 subtitles 里 */
export function checkSymbolConventions(texts: string[]): Issue[] {
  const joined = texts.join('\n');
  const issues: Issue[] = [];
  for (const pair of SYMBOL_PAIRS.slice(0, 3)) {
    const used = countChar(joined, pair.open) > 0;
    if (!used) {
      issues.push({
        code: 'symbol-missing',
        where: '全片',
        message: `四类符号约定里的一类从未使用：${pair.name}`,
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* 4b. 符号放错位置：params.audio 只能是元信息                          */
/* ------------------------------------------------------------------ */

/**
 * M4d-fix2：真模型把 `(低沉的钢琴单音)` / `<便利店门铃声>` 写进了 `params.audio`，
 * 而提示词正文里这些符号出现 0 次。Seedance 只从**提示词正文**解析音乐与音效，
 * 写在 `params` 里等于把这条声音丢掉 —— 契约与示例必须一致地判它不合格。
 *
 * 只查 `params.audio`：`params.subtitles` 的 【】 是合法形态（字幕本来就在参数里）。
 */
const AUDIO_FORBIDDEN_SYMBOLS = ['(', ')', '<', '>', '{', '}', '【', '】'];

function collectStrings(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, `${path}.${key}`, out);
    }
  }
}

export function checkAudioMetadata(audio: unknown, where = 'params.audio'): Issue[] {
  const fields: { path: string; text: string }[] = [];
  collectStrings(audio, where, fields);
  const issues: Issue[] = [];
  for (const field of fields) {
    const hits = AUDIO_FORBIDDEN_SYMBOLS.filter((symbol) => field.text.includes(symbol));
    if (hits.length === 0) continue;
    issues.push({
      code: 'symbol-misplaced',
      where: field.path,
      message: `音乐/音效符号必须写在提示词正文，不能放进 params.audio（发现「${hits.join(' ')}」）`,
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* 5. 锚点块 + 占位符                                                  */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /⟨([^⟩]+)⟩/g;
const WRONG_PLACEHOLDER = /\[锚点|【锚点|\{\{锚点|＜锚点/;

/** 占位符 `⟨锚点A⟩` 里的 id 既可能写成 `A`，也可能写成 `锚点A` —— 统一去掉前缀再比 */
function normalizeAnchorId(raw: string): string {
  return raw.replace(/^锚点\s*/, '').trim();
}

export function checkAnchorPlaceholders(texts: string[], anchorIds: string[]): Issue[] {
  const issues: Issue[] = [];
  const known = new Set(anchorIds.map(normalizeAnchorId));
  const used = new Set<string>();

  texts.forEach((text, index) => {
    const where = `分镜 #${index + 1}`;
    if (WRONG_PLACEHOLDER.test(text)) {
      issues.push({
        code: 'anchor-placeholder-form',
        where,
        message: '占位符写法不统一：只允许 ⟨锚点A⟩ 这一种形式',
      });
    }
    for (const match of text.matchAll(PLACEHOLDER)) {
      const id = normalizeAnchorId(match[1]);
      used.add(id);
      if (!known.has(id)) {
        issues.push({
          code: 'anchor-unknown',
          where,
          message: `占位符 ⟨${match[1]}⟩ 指向未声明的锚点`,
        });
      }
    }
  });

  for (const id of known) {
    if (!used.has(id)) {
      issues.push({
        code: 'anchor-unused',
        where: '锚点块',
        message: `锚点 ${id} 声明了但没有任何镜头引用`,
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* 6. 关键帧 = 镜头数 + 1                                              */
/* ------------------------------------------------------------------ */

export interface KeyframeLike {
  id?: unknown;
  description?: unknown;
}

export interface ShotLike {
  index?: unknown;
  first_keyframe?: unknown;
  last_keyframe?: unknown;
  prompt?: unknown;
  continuity?: unknown;
  shared_invariants?: unknown;
}

export function checkKeyframePairing(
  keyframes: KeyframeLike[],
  shots: ShotLike[],
): Issue[] {
  const issues: Issue[] = [];
  const ids = keyframes.map((item) => String(item.id ?? ''));
  if (ids.some((id) => id === '')) {
    issues.push({ code: 'keyframe-id', where: '关键帧', message: '有关键帧缺 id' });
  }
  if (new Set(ids).size !== ids.length) {
    issues.push({ code: 'keyframe-duplicate', where: '关键帧', message: '关键帧 id 有重复' });
  }
  if (keyframes.length !== shots.length + 1) {
    issues.push({
      code: 'keyframe-count',
      where: '关键帧',
      message: `关键帧 ${keyframes.length} 张，镜头 ${shots.length} 个 —— 首尾帧成对要求 N+1 张关键帧配 N 个镜头`,
    });
  }
  shots.forEach((shot, index) => {
    const where = `分镜 #${index + 1}`;
    const expectedFirst = ids[index];
    const expectedLast = ids[index + 1];
    if (expectedFirst !== undefined && shot.first_keyframe !== expectedFirst) {
      issues.push({
        code: 'keyframe-first',
        where,
        message: `首帧应为 ${expectedFirst}，实际 ${String(shot.first_keyframe)}`,
      });
    }
    if (expectedLast !== undefined && shot.last_keyframe !== expectedLast) {
      issues.push({
        code: 'keyframe-last',
        where,
        message: `末帧应为 ${expectedLast}，实际 ${String(shot.last_keyframe)}`,
      });
    }
  });
  return issues;
}

/* ------------------------------------------------------------------ */
/* 7. 必填 JSON 字段（按 io_contract 的类型表达式）                     */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkType(value: unknown, spec: TypeSpec, path: string): Issue[] {
  switch (spec.kind) {
    case 'string':
      return typeof value === 'string' && value.trim() !== ''
        ? []
        : [{ code: 'field-type', where: path, message: '应为非空字符串' }];
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? []
        : [{ code: 'field-type', where: path, message: '应为数字' }];
    case 'boolean':
      return typeof value === 'boolean'
        ? []
        : [{ code: 'field-type', where: path, message: '应为布尔值' }];
    case 'object': {
      if (!isRecord(value)) {
        return [{ code: 'field-type', where: path, message: '应为对象' }];
      }
      const issues: Issue[] = [];
      for (const field of spec.fields) {
        const child = value[field.key];
        if (child === undefined || child === null) {
          // 契约里写了 `X | null` 的字段，null 是合法值（例：negative）
          const nullable = field.spec.kind === 'unknown' && /\bnull\b/.test(field.spec.raw);
          if (child === null && nullable) continue;
          if (!field.optional) {
            issues.push({
              code: 'field-missing',
              where: `${path}.${field.key}`,
              message: '必填字段缺失',
            });
          }
          continue;
        }
        issues.push(...checkType(child, field.spec, `${path}.${field.key}`));
      }
      return issues;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return [{ code: 'field-type', where: path, message: '应为数组' }];
      }
      const issues: Issue[] = [];
      value.forEach((item, index) => {
        issues.push(...checkType(item, spec.item, `${path}[${index}]`));
      });
      return issues;
    }
    default:
      return [];
  }
}

/** 把 frontmatter 里的类型表达式（可能是字符串，也可能是嵌套映射）还原成一段源文本 */
function yamlToTypeSource(value: YamlValue): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map(yamlToTypeSource).join(', ')}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `${key}: ${yamlToTypeSource(item)}`)
    .join(', ')}}`;
}

export function checkRequiredFields(
  output: unknown,
  contract: Record<string, YamlValue>,
): Issue[] {
  const fields = Object.entries(contract).map(
    ([key, value]) => `${key}: ${yamlToTypeSource(value)}`,
  );
  const spec = parseTypeSpec(`{${fields.join(', ')}}`);
  return checkType(output, spec, 'output');
}

/* ------------------------------------------------------------------ */
/* 8. 各 pack 的专用规则                                               */
/* ------------------------------------------------------------------ */

export interface PackContract {
  name: string;
  io_contract: { input: Record<string, YamlValue>; output: Record<string, YamlValue> };
}

const SPECULATION_WORDS = ['可能', '也许', '或许', '像是', '大概', '某种程度上', '看起来'];

const DIAGNOSIS_WORDS = [
  '诊断',
  '确诊',
  '抑郁症',
  '焦虑症',
  '创伤后应激',
  '人格障碍',
  '精神分裂',
  '你应该',
  '你必须',
  '预兆',
  '凶兆',
  '灵异',
  '宿命',
];

const CLICHE_PATTERNS = [
  /命运的齿轮/,
  /这一切都要从/,
  /从此(他|她|它)?的人生改变了/,
  /有些事(情)?注定/,
  /这是一场关于/,
];

const MENTAL_VERBS = ['感到', '意识到', '明白了', '心想', '心情', '内心'];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function charCount(text: string): number {
  return Array.from(text).length;
}

function findSourceOverlap(source: string, text: string): string | null {
  const runs = source.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const candidates = new Set<string>();
  for (const run of runs) {
    for (let length = 6; length >= 3; length--) {
      for (let i = 0; i + length <= run.length; i++) {
        candidates.add(run.slice(i, i + length));
      }
    }
  }
  for (const candidate of candidates) {
    if (text.includes(candidate)) return candidate;
  }
  return null;
}

function validateDream(output: Record<string, unknown>, input: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  const interpretation = str(output.interpretation);
  const length = charCount(interpretation);
  if (length < 200 || length > 500) {
    issues.push({
      code: 'dream-length',
      where: 'interpretation',
      message: `${length} 字，要求 200–500 字`,
    });
  }
  for (const word of DIAGNOSIS_WORDS) {
    if (interpretation.includes(word)) {
      issues.push({
        code: 'dream-forbidden',
        where: 'interpretation',
        message: `出现禁止内容「${word}」（诊断/建议/吉凶判断）`,
      });
    }
  }
  if (/据《|第\s*\d+\s*页|弗洛伊德说过|荣格指出/.test(interpretation)) {
    issues.push({
      code: 'dream-citation',
      where: 'interpretation',
      message: '出现疑似编造的文献引用',
    });
  }

  const symbols = Array.isArray(output.symbols) ? output.symbols : [];
  if (symbols.length < 3) {
    issues.push({
      code: 'dream-symbols-count',
      where: 'symbols',
      message: `symbols ${symbols.length} 项，至少 3 项`,
    });
  }
  if (symbols.length > 6) {
    issues.push({
      code: 'dream-symbols-count',
      where: 'symbols',
      message: `symbols ${symbols.length} 项，最多 6 项（多了会变成符号词典）`,
    });
  }
  const source = str(input.dream_text);
  symbols.forEach((item, index) => {
    const record = isRecord(item) ? item : {};
    const symbol = str(record.symbol);
    const meaning = str(record.meaning);
    if (source && !source.includes(symbol)) {
      issues.push({
        code: 'dream-symbol-source',
        where: `symbols[${index}]`,
        message: `「${symbol}」在 dream_text 原文里找不到 —— 必须取自用户原文意象`,
      });
    }
    if (!SPECULATION_WORDS.some((word) => meaning.includes(word))) {
      issues.push({
        code: 'dream-symbol-hedge',
        where: `symbols[${index}]`,
        message: '含义缺推测词（可能/也许/或许…），被写成了定论',
      });
    }
  });

  const disclaimer = str(output.disclaimer);
  if (!disclaimer.includes('不构成') || !(disclaimer.includes('心理') || disclaimer.includes('医疗'))) {
    issues.push({
      code: 'dream-disclaimer',
      where: 'disclaimer',
      message: '免责声明必须包含「不构成」+「心理」或「医疗」',
    });
  }
  return issues;
}

function validateStoryExpansion(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
): Issue[] {
  const issues: Issue[] = [];
  const directions = Array.isArray(output.directions) ? output.directions : [];
  if (directions.length !== 3) {
    issues.push({
      code: 'story-count',
      where: 'directions',
      message: `要求恰好 3 个方向，实际 ${directions.length} 个`,
    });
  }
  const source = str(input.record_text);
  const conflictKinds: string[] = [];

  directions.forEach((item, index) => {
    const where = `directions[${index}]`;
    const record = isRecord(item) ? item : {};
    const title = str(record.title);
    const logline = str(record.logline);
    const why = str(record.why_it_holds);
    const conflict = str(record.conflict);
    const beats = Array.isArray(record.beats) ? record.beats.map(str) : [];
    const borrowed = Array.isArray(record.borrowed) ? record.borrowed.map(str) : [];

    if (charCount(title) > 12) {
      issues.push({ code: 'story-title', where, message: `title ${charCount(title)} 字，上限 12` });
    }
    if (charCount(logline) > 80) {
      issues.push({
        code: 'story-logline',
        where,
        message: `logline ${charCount(logline)} 字，上限 80`,
      });
    }
    if (charCount(why) > 60) {
      issues.push({ code: 'story-why', where, message: `why_it_holds ${charCount(why)} 字，上限 60` });
    }
    if (source && !findSourceOverlap(source, why)) {
      issues.push({
        code: 'story-why-source',
        where,
        message: 'why_it_holds 没有引用记录里的具体词（≥3 字的原文片段）',
      });
    }
    if (beats.length < 3 || beats.length > 5) {
      issues.push({
        code: 'story-beats',
        where,
        message: `beats ${beats.length} 条，要求 3–5 条`,
      });
    }
    beats.forEach((beat, beatIndex) => {
      const verb = MENTAL_VERBS.find((word) => beat.includes(word));
      if (verb) {
        issues.push({
          code: 'story-beat-mental',
          where: `${where}.beats[${beatIndex}]`,
          message: `「${verb}」是心理描写，beats 只写看得见的动作`,
        });
      }
    });
    if (borrowed.length === 0) {
      issues.push({ code: 'story-borrowed', where, message: 'borrowed 为空，借的和编的要分得清' });
    }
    for (const pattern of CLICHE_PATTERNS) {
      if (pattern.test(`${title}${logline}${why}`)) {
        issues.push({
          code: 'story-cliche',
          where,
          message: `出现套路化模板句：${pattern.source}`,
        });
      }
    }
    const kind = conflict.split(/[：:，,]/)[0].trim();
    conflictKinds.push(kind);
    if (!conflict) {
      issues.push({ code: 'story-conflict', where, message: 'conflict 为空' });
    }
  });

  const unique = new Set(conflictKinds);
  if (conflictKinds.length === 3 && unique.size < 3) {
    issues.push({
      code: 'story-conflict-duplicate',
      where: 'directions',
      message: `3 个方向的冲突源没有换（${conflictKinds.join(' / ')}）`,
    });
  }
  return issues;
}

const IMAGE_ELEMENT_KEYS = ['subject', 'shot', 'light', 'material', 'style'] as const;

function aspectMatchesSize(aspect: string, size: string): boolean {
  const aspectMatch = /^(\d+)\s*:\s*(\d+)$/.exec(aspect.trim());
  const sizeMatch = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  if (!aspectMatch || !sizeMatch) return false;
  const left = Number(aspectMatch[1]) * Number(sizeMatch[2]);
  const right = Number(aspectMatch[2]) * Number(sizeMatch[1]);
  return left === right;
}

function validateImagePrompt(output: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  const positive = str(output.positive);
  const words = promptWordCount(positive);
  if (words < 40 || words > 120) {
    issues.push({
      code: 'image-positive-length',
      where: 'positive',
      message: `positive ${words} 词，要求 40–120 词`,
    });
  }
  issues.push(...checkEmptyWords(positive, 'positive'));
  if (
    /\b\d{1,2}\s*[:：]\s*\d{1,2}\b|\d{3,4}\s*[x×]\s*\d{3,4}|\b(480p|720p|1080p|4k)\b|\d+\s*张|gpt-image|seedream/i.test(
      positive,
    )
  ) {
    issues.push({
      code: 'image-param-in-positive',
      where: 'positive',
      message: 'positive 里出现了参数（比例/尺寸/张数/模型名）——参数必须进 params',
    });
  }

  const elements = isRecord(output.elements) ? output.elements : {};
  for (const key of IMAGE_ELEMENT_KEYS) {
    if (str(elements[key]).trim() === '') {
      issues.push({
        code: 'image-element-missing',
        where: `elements.${key}`,
        message: `五要素缺「${key}」`,
      });
    }
  }

  const negative = output.negative;
  if (negative !== null && negative !== undefined) {
    const text = str(negative);
    if (text === '') {
      issues.push({ code: 'image-negative', where: 'negative', message: 'negative 只能为 null 或非空字符串' });
    } else if (promptWordCount(text) > 40) {
      issues.push({
        code: 'image-negative-length',
        where: 'negative',
        message: `negative ${promptWordCount(text)} 词，上限 40`,
      });
    }
  }

  const params = isRecord(output.params) ? output.params : {};
  for (const key of ['model', 'aspect_ratio', 'size', 'count'] as const) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      issues.push({ code: 'image-param-missing', where: `params.${key}`, message: '必填参数缺失' });
    }
  }
  if (
    str(params.aspect_ratio) !== '' &&
    str(params.size) !== '' &&
    !aspectMatchesSize(str(params.aspect_ratio), str(params.size))
  ) {
    issues.push({
      code: 'image-param-mismatch',
      where: 'params',
      message: `aspect_ratio ${str(params.aspect_ratio)} 与 size ${str(params.size)} 不自洽`,
    });
  }
  return issues;
}

const CONTINUITY_TYPES = ['opening', 'shared_frame', 'jump_cut'];
const REQUIRED_PARAM_KEYS = [
  'aspect',
  'width',
  'height',
  'fps',
  'total_seconds',
  'shot_seconds',
  'audio',
  'subtitles',
  'references',
  'tier',
];

/** video-storyboard 的 6 条硬要求 + 结构校验 */
export function validateStoryboard(output: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isRecord(output)) {
    return [{ code: 'storyboard-shape', where: 'output', message: '输出不是对象' }];
  }
  const anchors = Array.isArray(output.anchors) ? output.anchors : [];
  const keyframes = (Array.isArray(output.keyframes) ? output.keyframes : []) as KeyframeLike[];
  const shots = (Array.isArray(output.shots) ? output.shots : []) as ShotLike[];

  /* --- 锚点块 --- */
  if (anchors.length < 2) {
    issues.push({
      code: 'anchor-block',
      where: 'anchors',
      message: `锚点块只有 ${anchors.length} 条，至少要有角色与场景各一条`,
    });
  }
  const kinds = new Set<string>();
  anchors.forEach((item, index) => {
    const record = isRecord(item) ? item : {};
    const text = str(record.text);
    kinds.add(str(record.kind));
    if (str(record.id) === '') {
      issues.push({ code: 'anchor-id', where: `anchors[${index}]`, message: '锚点缺 id' });
    }
    if (charCount(text) < 20) {
      issues.push({
        code: 'anchor-text',
        where: `anchors[${index}]`,
        message: `锚点描述 ${charCount(text)} 字，太短（要能一字不改复用）`,
      });
    }
  });
  if (anchors.length > 0 && !kinds.has('character')) {
    issues.push({ code: 'anchor-kind', where: 'anchors', message: '没有 character 类型锚点' });
  }
  if (anchors.length > 0 && !kinds.has('scene')) {
    issues.push({ code: 'anchor-kind', where: 'anchors', message: '没有 scene 类型锚点' });
  }

  /* --- 关键帧 = 镜头 + 1 --- */
  issues.push(...checkKeyframePairing(keyframes, shots));
  keyframes.forEach((item, index) => {
    if (charCount(str(item.description)) < 15) {
      issues.push({
        code: 'keyframe-description',
        where: `keyframes[${index}]`,
        message: '关键帧描述太短，写不出构图/朝向/道具/光线',
      });
    }
    const next = keyframes[index + 1];
    if (next && str(next.description) === str(item.description)) {
      issues.push({
        code: 'keyframe-identical',
        where: `keyframes[${index}]`,
        message: '相邻两张关键帧描述完全相同（首帧与末帧必须是两个状态）',
      });
    }
  });

  /* --- 每镜 --- */
  const anchorIds = anchors.map((item) => str((isRecord(item) ? item : {}).id));
  const prompts = shots.map((shot) => str(shot.prompt));
  shots.forEach((shot, index) => {
    const where = `分镜 #${index + 1}`;
    const prompt = str(shot.prompt);
    issues.push(...checkPromptLength(prompt, where));
    issues.push(...checkParamSeparation(prompt, where));
    issues.push(...checkEmptyWords(prompt, where));
    issues.push(...checkSymbolPairs(prompt, where));

    const continuity = isRecord(shot.continuity) ? shot.continuity : {};
    const type = str(continuity.type);
    if (!CONTINUITY_TYPES.includes(type)) {
      issues.push({
        code: 'continuity-type',
        where,
        message: `continuity.type 只能是 ${CONTINUITY_TYPES.join(' / ')}，实际「${type}」`,
      });
    }
    const invariants = Array.isArray(shot.shared_invariants)
      ? shot.shared_invariants.map(str).filter((item) => item.trim() !== '')
      : [];
    if (type === 'shared_frame' && invariants.length < 3) {
      issues.push({
        code: 'continuity-invariants',
        where,
        message: '共享帧必须逐条列出共享不变量（至少 3 条：机位高度/道具位置/光向与色温/临时痕迹/肩线）',
      });
    }
    if (type === 'opening' && index !== 0) {
      issues.push({
        code: 'continuity-opening',
        where,
        message: '只有第 1 镜可以用 opening',
      });
    }
  });

  issues.push(...checkAnchorPlaceholders(prompts, anchorIds));
  issues.push(...checkSymbolConventions(prompts));

  /* --- 接续 SOP 文本块 --- */
  const sop = str(output.continuity_sop);
  if (charCount(sop) < 100) {
    issues.push({
      code: 'continuity-sop',
      where: 'continuity_sop',
      message: '接续 SOP 缺失或过短（要求 100 字以上，写清哪两镜共享帧、哪两镜跳切）',
    });
  }
  if (!/真实[^，。；]{0,8}末帧/.test(sop)) {
    issues.push({
      code: 'continuity-sop-real-frame',
      where: 'continuity_sop',
      message: '接续 SOP 必须点明「真实末帧 ≠ 规划末帧」这条',
    });
  }

  /* --- 参数分离 --- */
  const params = isRecord(output.params) ? output.params : {};
  for (const key of REQUIRED_PARAM_KEYS) {
    if (params[key] === undefined || params[key] === null) {
      issues.push({ code: 'params-missing', where: `params.${key}`, message: '参数缺失' });
    }
  }
  // 符号放错位置：`params.audio` 只能是元信息（音乐/音效写进提示词正文）
  issues.push(...checkAudioMetadata(params.audio));
  const shotSeconds = Array.isArray(params.shot_seconds) ? params.shot_seconds : [];
  if (shotSeconds.length !== shots.length) {
    issues.push({
      code: 'params-shot-seconds',
      where: 'params.shot_seconds',
      message: `shot_seconds ${shotSeconds.length} 项，镜头 ${shots.length} 个，必须一镜一项`,
    });
  }
  const sum = shotSeconds.reduce<number>(
    (total, value) => total + (typeof value === 'number' ? value : 0),
    0,
  );
  if (typeof params.total_seconds === 'number' && Math.abs(sum - params.total_seconds) > 1e-6) {
    issues.push({
      code: 'params-total',
      where: 'params',
      message: `total_seconds ${params.total_seconds} ≠ shot_seconds 之和 ${sum}`,
    });
  }
  const subtitles = str(params.subtitles);
  if (subtitles !== '' && !(subtitles.startsWith('【') && subtitles.endsWith('】'))) {
    issues.push({
      code: 'params-subtitles',
      where: 'params.subtitles',
      message: '字幕必须用【】包裹',
    });
  }
  if (subtitles === '' && !prompts.some((prompt) => prompt.includes('【'))) {
    issues.push({
      code: 'symbol-subtitle-missing',
      where: '全片',
      message: '字幕符号【】一次都没用（subtitles 为空时至少要在提示词里出现）',
    });
  }
  if (str(params.aspect) !== '' && !/^\d+\s*:\s*\d+$/.test(str(params.aspect))) {
    issues.push({
      code: 'params-aspect',
      where: 'params.aspect',
      message: `aspect「${str(params.aspect)}」不是 n:m 形式`,
    });
  }

  const joinedPrompts = prompts.join('\n');
  if (/共时|同时发生/.test(joinedPrompts)) {
    issues.push({
      code: 'storyboard-simultaneous',
      where: '全片',
      message: '出现「共时/同时发生」——一个镜头里做不完的动作要拆镜',
    });
  }
  return issues;
}

const SPECIALIZED: Record<
  string,
  (output: Record<string, unknown>, input: Record<string, unknown>) => Issue[]
> = {
  'dream-interpretation': validateDream,
  'story-expansion': validateStoryExpansion,
  'image-prompt-optimizer': (output) => validateImagePrompt(output),
  'video-storyboard': (output) => validateStoryboard(output),
};

/** pack 输出校验的入口：必填字段 + 该 pack 的专用规则 */
export function validatePackOutput(
  pack: PackContract,
  output: unknown,
  input: Record<string, unknown> = {},
): Issue[] {
  const issues: Issue[] = [];
  if (!isRecord(output)) {
    return [{ code: 'output-shape', where: 'output', message: '输出必须是 JSON 对象' }];
  }
  issues.push(...checkRequiredFields(output, pack.io_contract.output));
  const specialized = SPECIALIZED[pack.name];
  if (specialized) issues.push(...specialized(output, input));
  return issues;
}

/** 便于测试与报告：把 issue 列表压成一行行文字 */
export function formatIssues(issues: Issue[]): string {
  return issues.map((issue) => `[${issue.code}] ${issue.where ?? '-'}：${issue.message}`).join('\n');
}

/** 供 fixture 里写「故意不合规」样例时复用（避免测试里散落魔法字符串） */
export function knownSymbolNames(): string[] {
  return SYMBOL_PAIRS.map((pair) => pair.name);
}

export function parseOutputContract(value: YamlValue): TypeSpec {
  return parseTypeSpec(String(value));
}

export function topLevelOutputFields(contract: Record<string, YamlValue>): string[] {
  return Object.keys(contract).flatMap((key) => splitTopLevel(key));
}
