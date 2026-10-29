import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteWorkflowDatabase,
  listWorkflows,
  loadWorkflow,
  normalizeWorkflow,
  saveWorkflow,
  serializeWorkflow,
} from './db';
import type { Workflow } from './types';
import { useWorkflowStore } from './store';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf_test',
    name: '测试工作流',
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: [
      { id: 'a', type: 'source', position: { x: 12, y: 34 }, data: { text: '一段梦' } },
      { id: 'b', type: 'pack', position: { x: 260.5, y: 34 }, data: { packId: 'dream-interpretation' } },
      { id: 'c', type: 'output', position: { x: 520, y: 40 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  await deleteWorkflowDatabase();
  useWorkflowStore.getState().reset();
});

describe('序列化往返（判据 5）', () => {
  it('保存 → 读回：节点/边数量与坐标一致', async () => {
    const original = makeWorkflow();
    await saveWorkflow(original);
    const loaded = await loadWorkflow(original.id);

    expect(loaded).toBeDefined();
    expect(loaded?.nodes).toHaveLength(3);
    expect(loaded?.edges).toHaveLength(2);
    expect(loaded?.nodes.map((node) => node.position)).toEqual([
      { x: 12, y: 34 },
      { x: 260.5, y: 34 },
      { x: 520, y: 40 },
    ]);
    expect(loaded?.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      'a->b',
      'b->c',
    ]);
    expect(loaded?.name).toBe('测试工作流');
  });

  it('运行期状态不落库：存储时 running，读回没有 status（刷新后不会显示成"运行中"）', async () => {
    const running = makeWorkflow({
      nodes: [
        {
          id: 'a',
          type: 'source',
          position: { x: 0, y: 0 },
          data: { text: 'x', status: 'running', error: '上一轮的错', warning: '黄条' },
        },
      ],
      edges: [],
    });
    const serialized = serializeWorkflow(running);
    expect(serialized.nodes[0].data.status).toBeUndefined();
    expect(serialized.nodes[0].data.error).toBeUndefined();
    expect(serialized.nodes[0].data.warning).toBeUndefined();

    await saveWorkflow(running);
    const loaded = await loadWorkflow(running.id);
    expect(loaded?.nodes[0].data.status).toBeUndefined();
  });

  it('store 往返：loadWorkflow → toWorkflow 坐标与连线不变', () => {
    const original = makeWorkflow();
    useWorkflowStore.getState().loadWorkflow(original);
    const roundTrip = useWorkflowStore.getState().toWorkflow(() => 9_999);

    expect(roundTrip.nodes.map((node) => node.position)).toEqual(
      original.nodes.map((node) => node.position),
    );
    expect(roundTrip.edges.map((edge) => edge.id)).toEqual(['e1', 'e2']);
    expect(roundTrip.updatedAt).toBe(9_999);
  });

  it('加载后所有节点状态是 idle（避免"假运行中"）', () => {
    useWorkflowStore.getState().loadWorkflow(makeWorkflow());
    const nodes = useWorkflowStore.getState().nodes;
    expect(nodes.every((node) => node.data.status === 'idle')).toBe(true);
  });
});

describe('列表与边界', () => {
  it('listWorkflows 按 updatedAt 倒序', async () => {
    await saveWorkflow({ ...makeWorkflow({ id: 'wf_old', updatedAt: 10 }), name: '旧' });
    await saveWorkflow({ ...makeWorkflow({ id: 'wf_new', updatedAt: 20 }), name: '新' });

    const list = await listWorkflows();
    expect(list.map((item) => item.id)).toEqual(['wf_new', 'wf_old']);
  });

  it('normalizeWorkflow 丢弃坏节点与指向不存在节点的边', () => {
    const normalized = normalizeWorkflow({
      id: 'wf_bad',
      name: '坏数据',
      nodes: [
        { id: 'a', type: 'source', position: { x: 1, y: 2 }, data: { text: 'x' } },
        { id: 'b', type: '不存在的类型', position: { x: 0, y: 0 }, data: {} },
        { type: 'pack', position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'missing' },
      ],
    });

    expect(normalized?.nodes).toHaveLength(1);
    expect(normalized?.edges).toHaveLength(0);
  });

  it('坐标缺失/非数字 → 归零，不抛错', () => {
    const normalized = normalizeWorkflow({
      id: 'wf_nan',
      nodes: [{ id: 'a', type: 'source', position: { x: 'bad', y: Number.NaN }, data: {} }],
      edges: [],
    });
    expect(normalized?.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('没有 id 的行直接判非法（不会插进库里的脏行）', () => {
    expect(normalizeWorkflow({ name: '没有 id' })).toBeNull();
    expect(normalizeWorkflow('不是对象')).toBeNull();
  });
});
