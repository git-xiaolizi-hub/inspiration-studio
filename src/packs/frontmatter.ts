/**
 * prompt-pack 的 frontmatter 解析（YAML 的一个受限子集，手写，不引依赖）。
 *
 * 为什么不装 yaml 库：CHARTER §2 M4 明确「不引入新依赖」，而 frontmatter 只用到四种结构：
 *   1. `key: 标量`
 *   2. `key: {a: string, b?: string}`（流式映射，可嵌套在 `Array<...>` 里）
 *   3. `key:` + `  - 列表项`
 *   4. `key:` + `  sub: 标量`
 * 解析器只认这四种，遇到别的结构**直接抛错**而不是猜——pack 是给人写的，
 * 静默误解析比报错危险得多。
 *
 * 顺带提供类型表达式（`string` / `Array<{a: string}>`）的解析与校验，
 * 用来做「必填 JSON 字段」的机械判定（CHARTER §5 的 io_contract）。
 */

export type YamlValue = string | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

/* ------------------------------------------------------------------ */
/* frontmatter                                                         */
/* ------------------------------------------------------------------ */

/** 从 SKILL.md 原文里取出 frontmatter 与正文；没有 frontmatter 直接抛错 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('缺少 frontmatter：文件第一行必须是 ---');
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new Error('frontmatter 没有闭合的 ---');
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

/** 解析 frontmatter 的受限 YAML 子集 */
export function parseYamlSubset(source: string): YamlMap {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const root: YamlMap = {};
  let map: YamlMap | null = null;
  let list: YamlValue[] | null = null;

  const nextMeaningIsList = (from: number): boolean => {
    for (let i = from + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      return trimmed.startsWith('- ');
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      const sep = rawLine.indexOf(':');
      if (sep <= 0) throw new Error(`frontmatter 第 ${i + 1} 行不是 key: value → ${rawLine}`);
      const key = rawLine.slice(0, sep).trim();
      const rest = rawLine.slice(sep + 1).trim();
      map = null;
      list = null;
      if (rest !== '') {
        root[key] = parseValue(rest, i);
      } else if (nextMeaningIsList(i)) {
        const items: YamlValue[] = [];
        root[key] = items;
        list = items;
      } else {
        const child: YamlMap = {};
        root[key] = child;
        map = child;
      }
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (!list) throw new Error(`frontmatter 第 ${i + 1} 行的列表项没有归属 → ${rawLine}`);
      list.push(parseValue(trimmed.slice(2).trim(), i));
      continue;
    }

    if (!map) throw new Error(`frontmatter 第 ${i + 1} 行缩进异常 → ${rawLine}`);
    const sep = trimmed.indexOf(':');
    if (sep <= 0) throw new Error(`frontmatter 第 ${i + 1} 行不是 key: value → ${rawLine}`);
    const key = trimmed.slice(0, sep).trim();
    const rest = trimmed.slice(sep + 1).trim();
    if (rest !== '') {
      map[key] = parseValue(rest, i);
      list = null;
    } else if (nextMeaningIsList(i)) {
      const items: YamlValue[] = [];
      map[key] = items;
      list = items;
    } else {
      throw new Error(`frontmatter 第 ${i + 1} 行：本解析器只支持两级（不支持三层嵌套）`);
    }
  }
  return root;
}

function parseValue(raw: string, lineIndex: number): YamlValue {
  const value = raw.trim();
  if (value.startsWith('{') || value.startsWith('[')) {
    const parsed = parseFlowAt(value, 0);
    const rest = value.slice(parsed.end).trim();
    if (rest !== '') {
      throw new Error(`frontmatter 第 ${lineIndex + 1} 行：流式结构后面还有残留内容 → ${rest}`);
    }
    return parsed.value;
  }
  return unquote(value);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return trimmed;
}

interface FlowResult {
  value: YamlValue;
  /** 下一个待读位置（指向结束符之后） */
  end: number;
}

/**
 * 流式结构解析：`{...}` / `[...]`。
 * 标量里的 `< >` 也计层数——这样 `Array<{a: string, b: string}>` 内的逗号不会被当成字段分隔符。
 */
function parseFlowAt(source: string, start: number): FlowResult {
  let i = start;
  const skipSpace = (): void => {
    while (i < source.length && /\s/.test(source[i])) i++;
  };
  skipSpace();
  const head = source[i];

  if (head === '{') {
    i++;
    const map: YamlMap = {};
    for (;;) {
      skipSpace();
      if (source[i] === '}') {
        i++;
        return { value: map, end: i };
      }
      const keyStart = i;
      while (i < source.length && source[i] !== ':' && source[i] !== '}') i++;
      if (i >= source.length) throw new Error(`流式映射没有闭合：${source}`);
      const key = unquote(source.slice(keyStart, i));
      if (source[i] !== ':') throw new Error(`流式映射缺少冒号：${key}`);
      i++;
      skipSpace();
      const parsed = parseFlowAtom(source, i);
      map[key] = parsed.value;
      i = parsed.end;
      skipSpace();
      if (source[i] === ',') {
        i++;
        continue;
      }
      if (source[i] === '}') {
        i++;
        return { value: map, end: i };
      }
      throw new Error(`流式映射格式错误（位置 ${i}）：${source}`);
    }
  }

  if (head === '[') {
    i++;
    const items: YamlValue[] = [];
    for (;;) {
      skipSpace();
      if (source[i] === ']') {
        i++;
        return { value: items, end: i };
      }
      const parsed = parseFlowAtom(source, i);
      items.push(parsed.value);
      i = parsed.end;
      skipSpace();
      if (source[i] === ',') {
        i++;
        continue;
      }
      if (source[i] === ']') {
        i++;
        return { value: items, end: i };
      }
      throw new Error(`流式数组格式错误（位置 ${i}）：${source}`);
    }
  }

  return parseFlowAtom(source, i);
}

function parseFlowAtom(source: string, start: number): FlowResult {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i++;
  const head = source[i];
  if (head === '{' || head === '[') return parseFlowAt(source, i);

  if (head === '"' || head === "'") {
    const quote = head;
    i++;
    let text = '';
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\' && quote === '"' && i + 1 < source.length) {
        i++;
        text += source[i];
      } else {
        text += source[i];
      }
      i++;
    }
    if (source[i] !== quote) throw new Error(`引号没有闭合：${source}`);
    return { value: text, end: i + 1 };
  }

  let text = '';
  const closers: Record<string, string> = { '<': '>', '{': '}', '[': ']', '(': ')' };
  const stack: string[] = [];
  while (i < source.length) {
    const ch = source[i];
    if (stack.length === 0 && (ch === ',' || ch === '}' || ch === ']')) break;
    if (ch in closers) stack.push(closers[ch]);
    else if (stack.length > 0 && ch === stack[stack.length - 1]) stack.pop();
    text += ch;
    i++;
  }
  return { value: unquote(text), end: i };
}

/* ------------------------------------------------------------------ */
/* io_contract 的类型表达式                                             */
/* ------------------------------------------------------------------ */

export type TypeSpec =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'object'; fields: { key: string; optional: boolean; spec: TypeSpec }[] }
  | { kind: 'array'; item: TypeSpec }
  | { kind: 'unknown'; raw: string };

/** 把 `{a: string, b?: number, c: Array<{d: string}>}` 解析成结构 */
export function parseTypeSpec(source: string): TypeSpec {
  const text = source.trim();
  if (text === 'string') return { kind: 'string' };
  if (text === 'number') return { kind: 'number' };
  if (text === 'boolean') return { kind: 'boolean' };
  if (text === 'object') return { kind: 'object', fields: [] };

  const arrayMatch = /^Array<([\s\S]+)>$/.exec(text);
  if (arrayMatch) return { kind: 'array', item: parseTypeSpec(arrayMatch[1]) };

  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1);
    const fields = splitTopLevel(inner).map((rawField) => {
      const field = rawField.trim();
      if (!field) return null;
      const sep = findTopLevelColon(field);
      if (sep < 0) throw new Error(`类型表达式字段缺少冒号：${field}`);
      let key = field.slice(0, sep).trim();
      const optional = key.endsWith('?');
      if (optional) key = key.slice(0, -1).trim();
      return { key, optional, spec: parseTypeSpec(field.slice(sep + 1)) };
    });
    return {
      kind: 'object',
      fields: fields.filter((item): item is { key: string; optional: boolean; spec: TypeSpec } =>
        Boolean(item),
      ),
    };
  }

  return { kind: 'unknown', raw: text };
}

function findTopLevelColon(source: string): number {
  const stack: string[] = [];
  const closers: Record<string, string> = { '<': '>', '{': '}', '[': ']', '(': ')' };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (stack.length === 0 && ch === ':') return i;
    if (ch in closers) stack.push(closers[ch]);
    else if (stack.length > 0 && ch === stack[stack.length - 1]) stack.pop();
  }
  return -1;
}

/** 顶层逗号切分（不切断 Array<...> / {...} 内部的逗号） */
export function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  const stack: string[] = [];
  const closers: Record<string, string> = { '<': '>', '{': '}', '[': ']', '(': ')' };
  let buffer = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === ',' && stack.length === 0) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    if (ch in closers) stack.push(closers[ch]);
    else if (stack.length > 0 && ch === stack[stack.length - 1]) stack.pop();
    buffer += ch;
  }
  if (buffer.trim() !== '') parts.push(buffer);
  return parts.map((item) => item.trim()).filter((item) => item !== '');
}
