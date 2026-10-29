import { describe, expect, it } from 'vitest';
import { WorkflowGraphError, checkConnection, resolveEdges, topoSort, validateWorkflowGraph } from './graph';
import type { ExecEdge, ExecNode } from './types';

const node = (id: string, type: ExecNode['type'], data: ExecNode['data'] = {}): ExecNode => ({
  id,
  type,
  data,
});
/** 不带端口的边（老数据形态，靠兜底推断） */
const edge = (source: string, target: string): ExecEdge => ({ source, target });
/** 带端口的边 */
const port = (source: string, sourceHandle: string, target: string, targetHandle: string): ExecEdge => ({
  source,
  target,
  sourceHandle,
  targetHandle,
});

const source = node('a', 'source', { text: '一段梦' });
const pack = node('b', 'pack', { packId: 'dream-interpretation' });
const output = node('c', 'output');

function expectGraphError(fn: () => unknown, code: string): WorkflowGraphError {
  try {
    fn();
  } catch (caught) {
    expect(caught).toBeInstanceOf(WorkflowGraphError);
    expect((caught as WorkflowGraphError).code).toBe(code);
    return caught as WorkflowGraphError;
  }
  throw new Error(`期望抛 ${code} 错误，但没有抛`);
}

describe('拓扑排序（Kahn）', () => {
  it('线性 3 节点 → [a,b,c]', () => {
    const order = topoSort([source, pack, output], [edge('a', 'b'), edge('b', 'c')]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('节点数组顺序故意打乱，拓扑序仍然按依赖走', () => {
    const order = topoSort([output, source, pack], [edge('a', 'b'), edge('b', 'c')]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('菱形（A→B、A→C、B→D、C→D）排得出全序', () => {
    const order = topoSort(
      [
        node('a', 'source', { text: 'x' }),
        node('b', 'pack'),
        node('c', 'pack'),
        node('d', 'output'),
      ],
      [port('a', 'text', 'b', 'text'), port('a', 'text', 'c', 'text'), port('b', 'text', 'd', 'text'), port('c', 'text', 'd', 'text')],
    );
    expect(order).toHaveLength(4);
    expect(order[0]).toBe('a');
    expect(order[3]).toBe('d');
  });

  it('含环 → 抛 cycle', () => {
    expectGraphError(
      () =>
        topoSort(
          [node('m1', 'merge'), node('m2', 'merge')],
          [port('m1', 'text', 'm2', 'text1'), port('m2', 'text', 'm1', 'text1')],
        ),
      'cycle',
    );
  });
});

describe('图校验（DAG + 类型化端口）', () => {
  it('线性 3 节点通过，返回执行顺序', () => {
    expect(validateWorkflowGraph([source, pack, output], [edge('a', 'b'), edge('b', 'c')])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('一对多（A→B、A→C）现在合法 —— 这是 M5b2 的 #2 核心', () => {
    const order = validateWorkflowGraph(
      [node('a', 'source', { text: 'x' }), node('b', 'pack'), node('c', 'pack')],
      [port('a', 'text', 'b', 'text'), port('a', 'text', 'c', 'text')],
    );
    expect(order).toHaveLength(3);
    expect(order[0]).toBe('a');
  });

  it('多对一：两个文本源 → 文本合并 → 提示词包，合法', () => {
    const order = validateWorkflowGraph(
      [
        node('s1', 'source', { text: '甲' }),
        node('s2', 'source', { text: '乙' }),
        node('m', 'merge'),
        node('p', 'pack'),
      ],
      [
        port('s1', 'text', 'm', 'text1'),
        port('s2', 'text', 'm', 'text2'),
        port('m', 'text', 'p', 'text'),
      ],
    );
    expect(order).toEqual(['s1', 's2', 'm', 'p']);
  });

  it('类型不匹配（文本 → 参考图口）→ type-mismatch，消息含「类型不匹配」', () => {
    const error = expectGraphError(
      () =>
        validateWorkflowGraph(
          [node('a', 'source', { text: 'x' }), node('img', 'image', { modelId: 'm' })],
          [port('a', 'text', 'img', 'reference')],
        ),
      'type-mismatch',
    );
    expect(error.message).toContain('类型不匹配');
    expect(error.message).toContain('文本不能接到图片口');
  });

  it('同一个输入口两条线 → port-busy，消息含「最多一条线」', () => {
    const error = expectGraphError(
      () =>
        validateWorkflowGraph(
          [
            node('s1', 'source', { text: '甲' }),
            node('s2', 'source', { text: '乙' }),
            node('p', 'pack'),
          ],
          [port('s1', 'text', 'p', 'text'), port('s2', 'text', 'p', 'text')],
        ),
      'port-busy',
    );
    expect(error.message).toContain('最多一条线');
    expect(error.message).toContain('文本合并');
  });

  it('必填输入口没连 → missing-required-input', () => {
    expectGraphError(() => validateWorkflowGraph([pack, output], [edge('b', 'c')]), 'missing-required-input');
  });

  it('生图节点关掉「用上游文本」后，prompt 口可以不连', () => {
    const order = validateWorkflowGraph(
      [node('img', 'image', { modelId: 'm', promptFromUpstream: false, text: '自己的提示词' })],
      [],
    );
    expect(order).toEqual(['img']);
  });

  it('含环 → cycle（两条边互指的两个合并节点）', () => {
    const error = expectGraphError(
      () =>
        validateWorkflowGraph(
          [node('m1', 'merge'), node('m2', 'merge')],
          [port('m1', 'text', 'm2', 'text1'), port('m2', 'text', 'm1', 'text1')],
        ),
      'cycle',
    );
    expect(error.message).toContain('有环');
  });

  it('自环 → self-loop', () => {
    expectGraphError(() => validateWorkflowGraph([source], [edge('a', 'a')]), 'self-loop');
  });

  it('「输出」节点没有输出口，不能往外连 → unknown-port', () => {
    expectGraphError(
      () => validateWorkflowGraph([source, output], [edge('a', 'c'), edge('c', 'a')]),
      'unknown-port',
    );
  });

  it('端口名写错 → unknown-port', () => {
    expectGraphError(
      () => validateWorkflowGraph([source, pack], [port('a', 'text', 'b', 'nope')]),
      'unknown-port',
    );
  });

  it('同一条连线画两遍 → duplicate-edge', () => {
    expectGraphError(
      () =>
        validateWorkflowGraph(
          [source, pack],
          [port('a', 'text', 'b', 'text'), port('a', 'text', 'b', 'text')],
        ),
      'duplicate-edge',
    );
  });

  it('空画布 → empty', () => {
    expectGraphError(() => validateWorkflowGraph([], []), 'empty');
  });

  it('边指向不存在的节点 → missing-node', () => {
    expectGraphError(() => validateWorkflowGraph([source], [edge('a', 'zzz')]), 'missing-node');
  });

  it('节点 id 重复 → duplicate-node', () => {
    expectGraphError(
      () => validateWorkflowGraph([source, node('a', 'source', { text: 'y' })], []),
      'duplicate-node',
    );
  });
});

describe('老数据兼容（边里没有 handle 时兜底推断）', () => {
  it('source → pack 无 handle：落到 text → text', () => {
    const resolved = resolveEdges([source, pack], [edge('a', 'b')]);
    expect(resolved).toEqual([
      { source: 'a', target: 'b', sourcePort: 'text', targetPort: 'text', type: 'text' },
    ]);
  });

  it('生图 → 输出 无 handle：落到 image 口，不误判成类型不匹配', () => {
    const resolved = resolveEdges(
      [node('img', 'image', { modelId: 'm' }), output],
      [edge('img', 'c')],
    );
    expect(resolved[0].sourcePort).toBe('image');
    expect(resolved[0].targetPort).toBe('image');
    expect(resolved[0].type).toBe('image');
  });

  it('M5b 存下的老单链 source→pack→output 仍能通过校验', () => {
    expect(validateWorkflowGraph([source, pack, output], [edge('a', 'b'), edge('b', 'c')])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('checkConnection（连线落点那一刻的校验）', () => {
  it('类型不匹配 → ok:false 且给中文原因', () => {
    const verdict = checkConnection(
      [source, node('img', 'image', { modelId: 'm' })],
      [],
      { source: 'a', target: 'img', sourceHandle: 'text', targetHandle: 'reference' },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false ? verdict.message : '').toContain('类型不匹配');
  });

  it('一口已有线 → 拒绝并提示加「文本合并」', () => {
    const verdict = checkConnection(
      [source, node('s2', 'source', { text: '乙' }), pack],
      [{ source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' }],
      { source: 's2', target: 'b', sourceHandle: 'text', targetHandle: 'text' },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false ? verdict.message : '').toContain('最多一条线');
  });

  it('一对多：同一个输出接第二个下游 → 允许', () => {
    const verdict = checkConnection(
      [source, node('b', 'pack'), node('c', 'pack')],
      [{ source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' }],
      { source: 'a', target: 'c', sourceHandle: 'text', targetHandle: 'text' },
    );
    expect(verdict.ok).toBe(true);
  });

  it('自己连自己 → 拒绝', () => {
    const verdict = checkConnection([source], [], {
      source: 'a',
      target: 'a',
      sourceHandle: 'text',
      targetHandle: null,
    });
    expect(verdict.ok).toBe(false);
  });
});
