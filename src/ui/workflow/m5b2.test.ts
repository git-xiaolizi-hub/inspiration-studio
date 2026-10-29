/**
 * M5b2 的新增判据（任务书 §6）。
 *
 * 一个文件装五组："一对多 / 多对一"（执行器）、"删除"（store）、"模板"、"提示词可见"、（端口持久化）。
 * 单独开文件而不是塞进 executor.test.ts：这些用例对应的是委托人这次提的四条缺口，
 * 报告里要能一条一条指过去。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteWorkflowDatabase,
  loadWorkflow,
  saveWorkflow,
} from './db';
import { validateWorkflowGraph } from './graph';
import { executeWorkflow } from './executor';
import type { CostQuote, ExecuteDeps, MediaRef } from './executor';
import { packOutputFields, packSystemPrompt } from './packs';
import { useWorkflowStore } from './store';
import { WORKFLOW_TEMPLATES, instantiateTemplate } from './templates';
import type { ExecEdge, ExecNode, PackId } from './types';

const node = (id: string, type: ExecNode['type'], data: ExecNode['data'] = {}): ExecNode => ({
  id,
  type,
  data,
});
const port = (source: string, sourceHandle: string, target: string, targetHandle: string): ExecEdge => ({
  source,
  target,
  sourceHandle,
  targetHandle,
});

interface Harness {
  calls: string[];
  texts: Array<{ nodeId: string; text: string }>;
  refs: Array<{ nodeId: string; ref?: MediaRef }>;
  deps: ExecuteDeps;
}

function harness(overrides: Partial<ExecuteDeps> = {}): Harness {
  const calls: string[] = [];
  const texts: Array<{ nodeId: string; text: string }> = [];
  const refs: Array<{ nodeId: string; ref?: MediaRef }> = [];
  const deps: ExecuteDeps = {
    runPack: async (target, text) => {
      calls.push(`pack:${target.id}`);
      texts.push({ nodeId: target.id, text });
      return { text: `pack-out:${target.id}` };
    },
    runImage: async (target, _prompt, reference) => {
      calls.push(`image:${target.id}`);
      refs.push({ nodeId: target.id, ref: reference });
      return { media: { kind: 'image', url: 'blob:image', mimeType: 'image/png', blobId: 'image-blob:1' } };
    },
    runVideo: async (target, _prompt, firstFrame) => {
      calls.push(`video:${target.id}`);
      refs.push({ nodeId: target.id, ref: firstFrame });
      return { media: { kind: 'video', url: 'blob:video', mimeType: 'video/mp4' } };
    },
    // M5b4：图片源/视频源节点要读素材（模板 4 含「图片源」）
    readSource: async (target) => ({
      kind: target.type === 'videoSource' ? 'video' : 'image',
      url: 'blob:source',
      mimeType: target.type === 'videoSource' ? 'video/mp4' : 'image/png',
      blobId: 'source-blob:1',
    }),
    ...overrides,
  };
  return { calls, texts, refs, deps };
}

const quote: CostQuote = {
  nodeId: 'img',
  kind: 'image',
  amount: 0,
  modelId: 'cogview-3-flash',
  spec: '1 张',
  free: true,
  notices: [],
};

beforeEach(async () => {
  await deleteWorkflowDatabase();
  useWorkflowStore.getState().reset();
});

describe('一对多：上游只跑一次，结果被多处复用（判据 3）', () => {
  it('A→B、A→C：A 的 runPack 只被调用一次，两个下游拿到同一份文本', async () => {
    const { calls, deps } = harness();
    const result = await executeWorkflow(
      [
        node('s', 'source', { text: '一段梦' }),
        node('a', 'pack'),
        node('b', 'pack'),
        node('c', 'output'),
      ],
      [port('s', 'text', 'a', 'text'), port('a', 'text', 'b', 'text'), port('a', 'text', 'c', 'text')],
      deps,
    );
    expect(result.states.a.status).toBe('ok');
    expect(calls.filter((call) => call === 'pack:a')).toHaveLength(1);
    expect(calls).toEqual(['pack:a', 'pack:b']);
    expect(result.outputs.c?.text).toBe('pack-out:a');
  });

  it('一个输出接两个下游节点：上游只调用一次，两个下游都成功', async () => {
    const { calls, deps } = harness();
    const result = await executeWorkflow(
      [
        node('s', 'source', { text: '一段梦' }),
        node('p', 'pack'),
        node('q', 'pack'),
        node('out1', 'output'),
        node('out2', 'output'),
      ],
      [
        port('s', 'text', 'p', 'text'),
        port('p', 'text', 'q', 'text'),
        port('p', 'text', 'out1', 'text'),
        port('q', 'text', 'out2', 'text'),
      ],
      deps,
    );

    expect(calls.filter((call) => call === 'pack:p')).toHaveLength(1);
    expect(calls.filter((call) => call === 'pack:q')).toHaveLength(1);
    expect(result.states.out1.status).toBe('ok');
    expect(result.states.out2.status).toBe('ok');
    expect(result.outputs.out1?.text).toBe('pack-out:p');
    expect(result.outputs.out2?.text).toBe('pack-out:q');
  });

  it('上游失败时，它的两个下游都 skipped（一对多不改变失败传播）', async () => {
    const { calls, deps } = harness({
      runPack: async (target) => {
        calls.push(`pack:${target.id}`);
        throw new Error('模型超时');
      },
    });
    const result = await executeWorkflow(
      [node('s', 'source', { text: 'x' }), node('p', 'pack'), node('o1', 'output'), node('o2', 'output')],
      [port('s', 'text', 'p', 'text'), port('p', 'text', 'o1', 'text'), port('p', 'text', 'o2', 'text')],
      deps,
    );
    expect(calls).toEqual(['pack:p']);
    expect(result.states.o1.status).toBe('skipped');
    expect(result.states.o2.status).toBe('skipped');
  });
});

describe('多对一：两个素材 → 文本合并（判据 4）', () => {
  it('合并后的文本含两段原文，分隔符默认 \\n\\n，提示词包拿到的是合并结果', async () => {
    const { texts, deps } = harness();
    const result = await executeWorkflow(
      [
        node('s1', 'source', { text: '甲段' }),
        node('s2', 'source', { text: '乙段' }),
        node('m', 'merge'),
        node('p', 'pack'),
      ],
      [
        port('s1', 'text', 'm', 'text1'),
        port('s2', 'text', 'm', 'text2'),
        port('m', 'text', 'p', 'text'),
      ],
      deps,
    );

    expect(result.states.m.status).toBe('ok');
    expect(result.outputs.m?.text).toBe('甲段\n\n乙段');
    expect(texts).toEqual([{ nodeId: 'p', text: '甲段\n\n乙段' }]);
  });

  it('打开「加标签」→ 每段带【素材N】', async () => {
    const { deps } = harness();
    const result = await executeWorkflow(
      [
        node('s1', 'source', { text: '甲段' }),
        node('s2', 'source', { text: '乙段' }),
        node('m', 'merge', { labelParts: true }),
        node('p', 'pack'),
      ],
      [
        port('s1', 'text', 'm', 'text1'),
        port('s2', 'text', 'm', 'text2'),
        port('m', 'text', 'p', 'text'),
      ],
      deps,
    );
    expect(result.outputs.m?.text).toContain('【素材1】');
    expect(result.outputs.m?.text).toContain('【素材2】');
  });

  it('只接一个素材 → 拒绝（text1/text2 都是必填，免得用户以为「合并」真的发生了）', async () => {
    const { deps } = harness();
    await expect(
      executeWorkflow(
        [node('s1', 'source', { text: '只有一段' }), node('m', 'merge'), node('p', 'pack')],
        [port('s1', 'text', 'm', 'text1'), port('m', 'text', 'p', 'text')],
        deps,
      ),
    ).rejects.toThrow(/素材 2/);
  });
});

describe('媒体端口：参考图 / 首帧图', () => {
  it('生图不支持参考图 → 忽略并写 warning（不假装用了）', async () => {
    const { refs, deps } = harness({ imageReferenceSupported: false });
    const result = await executeWorkflow(
      [
        node('s', 'source', { text: '画面' }),
        node('i1', 'image', { modelId: 'm' }),
        node('i2', 'image', { modelId: 'm' }),
      ],
      [
        port('s', 'text', 'i1', 'prompt'),
        port('s', 'text', 'i2', 'prompt'),
        port('i1', 'image', 'i2', 'reference'),
      ],
      deps,
    );
    const second = refs.find((item) => item.nodeId === 'i2');
    expect(second?.ref).toBeUndefined();
    expect(result.states.i2.warning).toContain('不支持参考图');
  });

  it('生视频的「首帧图」口有值时，图会传给适配器', async () => {
    const { refs, deps } = harness();
    await executeWorkflow(
      [
        node('s', 'source', { text: '分镜' }),
        node('i1', 'image', { modelId: 'm' }),
        node('v', 'video', { modelId: 'vm' }),
      ],
      [
        port('s', 'text', 'i1', 'prompt'),
        port('s', 'text', 'v', 'prompt'),
        port('i1', 'image', 'v', 'firstFrame'),
      ],
      deps,
    );
    const videoCall = refs.find((item) => item.nodeId === 'v');
    expect(videoCall?.ref?.url).toBe('blob:image');
    expect(videoCall?.ref?.blobId).toBe('image-blob:1');
  });
});

describe('删除节点与连线（判据 5）', () => {
  function buildChain(): { a: string; b: string; c: string } {
    const store = useWorkflowStore.getState();
    const a = store.addNode('source', { x: 0, y: 0 });
    const b = useWorkflowStore.getState().addNode('pack', { x: 200, y: 0 });
    const c = useWorkflowStore.getState().addNode('output', { x: 400, y: 0 });
    useWorkflowStore.getState().updateNodeData(a, { text: '一段梦' });
    useWorkflowStore.getState().connect({ source: a, target: b, sourceHandle: 'text', targetHandle: 'text' });
    useWorkflowStore.getState().connect({ source: b, target: c, sourceHandle: 'text', targetHandle: 'text' });
    return { a, b, c };
  }

  it('删中间节点 → 它的两条边一起消失；剩下的图仍能通过校验', () => {
    const { b } = buildChain();
    expect(useWorkflowStore.getState().edges).toHaveLength(2);

    useWorkflowStore.getState().removeNodes([b]);

    const state = useWorkflowStore.getState();
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(0);

    const execNodes = state.nodes.map((item) => ({ id: item.id, type: item.type ?? 'source', data: item.data }));
    expect(() => validateWorkflowGraph(execNodes, [])).not.toThrow();
  });

  it('删掉一条边 → 图仍合法（另一条边不受影响）', () => {
    buildChain();
    const [first] = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().removeEdge(first.id);
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
  });

  it('Ctrl+Z 的底层：undoDelete 把节点与边一起放回来', () => {
    const { b } = buildChain();
    useWorkflowStore.getState().removeNodes([b]);
    expect(useWorkflowStore.getState().undoDelete()).toBe(true);
    expect(useWorkflowStore.getState().nodes).toHaveLength(3);
    expect(useWorkflowStore.getState().edges).toHaveLength(2);
    expect(useWorkflowStore.getState().undoDelete()).toBe(false);
  });

  it('清空画布后也能撤销一次', () => {
    buildChain();
    useWorkflowStore.getState().clearCanvas();
    expect(useWorkflowStore.getState().nodes).toHaveLength(0);
    useWorkflowStore.getState().undoDelete();
    expect(useWorkflowStore.getState().nodes).toHaveLength(3);
    expect(useWorkflowStore.getState().edges).toHaveLength(2);
  });

  it('删除选中的边（键盘 Delete 走的同一条路）', () => {
    buildChain();
    const edges = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().onEdgesChange([{ id: edges[0].id, type: 'select', selected: true }]);
    const removed = useWorkflowStore.getState().deleteSelection();
    expect(removed).toBe(1);
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
  });
});

describe('连线校验（store.connect）', () => {
  it('文本 → 参考图口被拒绝，消息写进 connectError', () => {
    const a = useWorkflowStore.getState().addNode('source');
    const img = useWorkflowStore.getState().addNode('image');
    const message = useWorkflowStore.getState().connect({
      source: a,
      target: img,
      sourceHandle: 'text',
      targetHandle: 'reference',
    });
    expect(message).toContain('类型不匹配');
    expect(useWorkflowStore.getState().connectError).toContain('类型不匹配');
    expect(useWorkflowStore.getState().edges).toHaveLength(0);
  });

  it('同一个输入口第二条线被拒绝', () => {
    const s1 = useWorkflowStore.getState().addNode('source');
    const s2 = useWorkflowStore.getState().addNode('source');
    const p = useWorkflowStore.getState().addNode('pack');
    useWorkflowStore.getState().connect({ source: s1, target: p, sourceHandle: 'text', targetHandle: 'text' });
    const message = useWorkflowStore.getState().connect({
      source: s2,
      target: p,
      sourceHandle: 'text',
      targetHandle: 'text',
    });
    expect(message).toContain('最多一条线');
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
  });

  it('一个输出接两个下游 → 两条边都在（不再顶掉旧边）', () => {
    const s = useWorkflowStore.getState().addNode('source');
    const p1 = useWorkflowStore.getState().addNode('pack');
    const p2 = useWorkflowStore.getState().addNode('pack');
    useWorkflowStore.getState().connect({ source: s, target: p1, sourceHandle: 'text', targetHandle: 'text' });
    useWorkflowStore.getState().connect({ source: s, target: p2, sourceHandle: 'text', targetHandle: 'text' });
    expect(useWorkflowStore.getState().edges).toHaveLength(2);
  });

  it('端口名跟着边一起存进 IndexedDB 再读回来', async () => {
    const s = useWorkflowStore.getState().addNode('source', { x: 0, y: 0 });
    const m = useWorkflowStore.getState().addNode('merge', { x: 200, y: 0 });
    useWorkflowStore.getState().connect({ source: s, target: m, sourceHandle: 'text', targetHandle: 'text2' });
    const workflow = useWorkflowStore.getState().toWorkflow();

    await saveWorkflow(workflow);
    const loaded = await loadWorkflow(workflow.id);

    expect(loaded?.edges[0].sourceHandle).toBe('text');
    expect(loaded?.edges[0].targetHandle).toBe('text2');
  });
});

describe('内置模板（判据 7；M5b4 增至四个，其中含「图片源」）', () => {
  const expected: Record<string, { nodes: number; edges: number }> = {
    'dream-to-image': { nodes: 4, edges: 3 },
    'copy-to-video': { nodes: 4, edges: 3 },
    'idea-to-text': { nodes: 3, edges: 2 },
    'image-to-video': { nodes: 4, edges: 3 },
  };

  it('模板数量正好 4 个，每张卡各有标题与一句人话说明', () => {
    expect(WORKFLOW_TEMPLATES).toHaveLength(4);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.title.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(10);
    }
  });

  it.each(Object.entries(expected))('%s 的节点/边数量符合预期，且提交给执行器时全部成功', async (id, want) => {
    const template = WORKFLOW_TEMPLATES.find((item) => item.id === id);
    expect(template).toBeDefined();
    const { nodes, edges } = instantiateTemplate(template!);
    expect(nodes).toHaveLength(want.nodes);
    expect(edges).toHaveLength(want.edges);

    // 能通过校验（端口/必填输入都对）
    const execNodes = nodes.map((item) => ({ id: item.id, type: item.type, data: item.data }));
    expect(() => validateWorkflowGraph(execNodes, edges)).not.toThrow();

    // 能跑（模型/费用全部 mock，不花钱）
    const { deps } = harness({ quote: () => quote, confirm: async () => true });
    const result = await executeWorkflow(execNodes, edges, deps);
    expect(Object.values(result.states).every((state) => state.status === 'ok')).toBe(true);
  });

  it('模板里的边显式带端口名（不靠兜底推断）', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const { edges } = instantiateTemplate(template);
      for (const edge of edges) {
        expect(edge.sourceHandle).toBeTruthy();
        expect(edge.targetHandle).toBeTruthy();
      }
    }
  });

  it('store.applyTemplate 把模板装进画布，并清掉撤销快照', () => {
    const template = WORKFLOW_TEMPLATES[0];
    useWorkflowStore.getState().applyTemplate(template);
    expect(useWorkflowStore.getState().nodes).toHaveLength(4);
    expect(useWorkflowStore.getState().edges).toHaveLength(3);
    expect(useWorkflowStore.getState().name).toBe(template.title);
    expect(useWorkflowStore.getState().lastDeleted).toBeNull();
  });
});

describe('新节点落点（不与已有节点重叠）', () => {
  it('模板节点已占据位置时，从左栏加的节点不会压上去', () => {
    useWorkflowStore.getState().applyTemplate(WORKFLOW_TEMPLATES[0]);
    for (const type of ['merge', 'output', 'pack'] as const) {
      useWorkflowStore.getState().addNode(type);
    }
    const positions = useWorkflowStore.getState().nodes.map((node) => node.position);
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const clash =
          Math.abs(positions[i].x - positions[j].x) < 200 &&
          Math.abs(positions[i].y - positions[j].y) < 120;
        expect(clash, `节点 ${i} 与 ${j} 重叠`).toBe(false);
      }
    }
  });
});

describe('提示词可见（判据 8）', () => {
  const cases: Array<{ packId: PackId; marker: string }> = [
    { packId: 'dream-interpretation', marker: '意象' },
    { packId: 'story-expansion', marker: '方向' },
    { packId: 'image-prompt-optimizer', marker: '提示词' },
    { packId: 'video-storyboard', marker: '分镜' },
  ];

  it.each(cases)('$packId 的 system prompt 非空且含特征词「$marker」', ({ packId, marker }) => {
    const prompt = packSystemPrompt(packId);
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt).toContain(marker);
    // 机器校验清单与硬禁止必须是同一份（真正发给模型的就是它）
    expect(prompt).toContain('机器校验清单');
    expect(prompt).toContain('硬禁止');
  });

  it('每个 pack 都给出输出字段名', () => {
    expect(packOutputFields('dream-interpretation')).toEqual(
      expect.arrayContaining(['interpretation', 'symbols', 'disclaimer']),
    );
    expect(packOutputFields('video-storyboard').length).toBeGreaterThan(0);
  });
});
