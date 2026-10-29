import { describe, expect, it } from 'vitest';
import { parseTypeSpec, parseYamlSubset, splitFrontmatter } from './frontmatter';
import { loadPack } from './runtime';

describe('frontmatter：受限 YAML 子集', () => {
  it('标量 / 流式映射 / 块列表 / 二级映射都能解析', () => {
    const parsed = parseYamlSubset(
      [
        'name: demo',
        'description: "带引号的说明"',
        'io_contract:',
        '  input: {a: string, b?: string}',
        '  output: {x: string, list: Array<{k: string, v: number}>}',
        'validation:',
        '  - "第一条"',
        "  - '第二条'",
        'anchors:',
        '  character_refs: "一人一图"',
      ].join('\n'),
    );

    expect(parsed.name).toBe('demo');
    expect(parsed.description).toBe('带引号的说明');
    expect(parsed.io_contract).toEqual({
      input: { a: 'string', 'b?': 'string' },
      output: { x: 'string', list: 'Array<{k: string, v: number}>' },
    });
    expect(parsed.validation).toEqual(['第一条', '第二条']);
    expect(parsed.anchors).toEqual({ character_refs: '一人一图' });
  });

  it('没有 frontmatter 直接抛错（不静默当成纯文本）', () => {
    expect(() => splitFrontmatter('# 只有正文\n')).toThrow(/frontmatter/);
  });

  it('frontmatter 没闭合也抛错', () => {
    expect(() => splitFrontmatter('---\nname: x\n')).toThrow(/闭合/);
  });

  it('正文与 frontmatter 正确分开', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\n# 角色\n正文\n');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('# 角色\n正文');
  });
});

describe('类型表达式：io_contract 的必填字段来源', () => {
  it('简单标量与可选字段', () => {
    const spec = parseTypeSpec('{a: string, b?: number}');
    expect(spec.kind).toBe('object');
    expect(spec.kind === 'object' && spec.fields.map((field) => [field.key, field.optional])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('嵌套数组里带逗号的字段不会被切开', () => {
    const spec = parseTypeSpec('{list: Array<{k: string, v: number}>}');
    expect(spec.kind === 'object' && spec.fields[0].spec.kind).toBe('array');
  });
});

describe('真实 pack 的 frontmatter', () => {
  it('video-storyboard 带视频类特殊字段（anchors / keyframe_mode / output_includes）', () => {
    const pack = loadPack('video-storyboard');
    expect(pack.extra.keyframe_mode).toBe('首尾帧成对(FLF)');
    const anchors = pack.extra.anchors;
    expect(typeof anchors === 'object' && !Array.isArray(anchors)).toBe(true);
    const includes = pack.extra.output_includes;
    expect(Array.isArray(includes)).toBe(true);
    expect((includes as unknown[]).length).toBe(3);
    expect(pack.io_contract.output.anchors).toBe('Array<object>');
  });

  it('四个 pack 的 name 与目录名一致', () => {
    for (const name of ['dream-interpretation', 'story-expansion', 'image-prompt-optimizer', 'video-storyboard']) {
      expect(loadPack(name).name).toBe(name);
    }
  });
});
