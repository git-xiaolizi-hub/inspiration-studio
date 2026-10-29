import { describe, expect, it } from 'vitest';
import { executeWorkflow } from './executor';
import type { CostQuote, ExecuteDeps } from './executor';
import { WorkflowGraphError } from './graph';
import type { ExecEdge, ExecNode, WFNodeType } from './types';

const node = (id: string, type: WFNodeType, data: ExecNode['data'] = {}): ExecNode => ({
  id,
  type,
  data,
});
const edge = (source: string, target: string): ExecEdge => ({ source, target });

interface Harness {
  calls: string[];
  deps: ExecuteDeps;
}

/** 所有处理器都记账；没被调到的就是"零请求" */
function harness(overrides: Partial<ExecuteDeps> = {}): Harness {
  const calls: string[] = [];
  const deps: ExecuteDeps = {
    runPack: async (target) => {
      calls.push(`pack:${target.id}`);
      return { text: `pack-out:${target.id}` };
    },
    runImage: async (target) => {
      calls.push(`image:${target.id}`);
      return { media: { kind: 'image', url: 'blob:image', mimeType: 'image/png' } };
    },
    runVideo: async (target) => {
      calls.push(`video:${target.id}`);
      return { media: { kind: 'video', url: 'blob:video', mimeType: 'video/mp4' } };
    },
    ...overrides,
  };
  return { calls, deps };
}

const quote: CostQuote = {
  nodeId: 'img',
  kind: 'image',
  amount: 1.2,
  modelId: 'cogview-3-flash',
  spec: '1 张',
  free: false,
  notices: [],
};

describe('顺序执行', () => {
  it('线性 3 节点按 [a,b,c] 依次执行，output 拿到上游文本', async () => {
    const { calls, deps } = harness();
    const result = await executeWorkflow(
      [node('a', 'source', { text: '一段梦' }), node('b', 'pack'), node('c', 'output')],
      [edge('a', 'b'), edge('b', 'c')],
      deps,
    );

    expect(result.order).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual(['pack:b']);
    expect(result.states.a.status).toBe('ok');
    expect(result.states.b.status).toBe('ok');
    expect(result.states.c.status).toBe('ok');
    expect(result.outputs.c?.text).toBe('pack-out:b');
  });

  it('每步都写回状态（UI 才能实时亮）', async () => {
    const seen: Array<[string, string]> = [];
    const { deps } = harness({
      onStatus: (nodeId, patch) => {
        if (patch.status) seen.push([nodeId, patch.status]);
      },
    });
    await executeWorkflow(
      [node('a', 'source', { text: 'x' }), node('c', 'output')],
      [edge('a', 'c')],
      deps,
    );
    expect(seen).toContainEqual(['a', 'running']);
    expect(seen).toContainEqual(['a', 'ok']);
    expect(seen).toContainEqual(['c', 'running']);
    expect(seen).toContainEqual(['c', 'ok']);
  });
});

describe('图不合法 → 一个请求都不发（判据 1）', () => {
  it('含环 → 抛 cycle 且零处理器调用', async () => {
    const { calls, deps } = harness();
    await expect(
      executeWorkflow(
        [node('m1', 'merge'), node('m2', 'merge')],
        [edge('m1', 'm2'), edge('m2', 'm1')],
        deps,
      ),
    ).rejects.toBeInstanceOf(WorkflowGraphError);
    expect(calls).toEqual([]);
  });

  it('类型不匹配的边 → 抛 type-mismatch 且零处理器调用', async () => {
    const { calls, deps } = harness();
    await expect(
      executeWorkflow(
        [node('a', 'source', { text: 'x' }), node('img', 'image', { modelId: 'm' })],
        [{ source: 'a', target: 'img', sourceHandle: 'text', targetHandle: 'reference' }],
        deps,
      ),
    ).rejects.toThrow(/类型不匹配/);
    expect(calls).toEqual([]);
  });
});

describe('失败传播（判据 2）', () => {
  it('上游 pack 失败 → 下游 image skipped，且零请求', async () => {
    const { calls, deps } = harness({
      runPack: async () => {
        calls.push('pack:b');
        throw new Error('模型超时');
      },
    });
    const result = await executeWorkflow(
      [
        node('a', 'source', { text: 'x' }),
        node('b', 'pack'),
        node('img', 'image', { modelId: 'cogview-3-flash' }),
        node('out', 'output'),
      ],
      [edge('a', 'b'), edge('b', 'img'), edge('img', 'out')],
      deps,
    );

    expect(calls).toEqual(['pack:b']);
    expect(result.states.b.status).toBe('error');
    expect(result.states.b.error).toContain('模型超时');
    expect(result.states.img.status).toBe('skipped');
    expect(result.states.out.status).toBe('skipped');
  });

  it('source 文本为空 → error，下游 skipped', async () => {
    const { calls, deps } = harness();
    const result = await executeWorkflow(
      [node('a', 'source', { text: '   ' }), node('c', 'output')],
      [edge('a', 'c')],
      deps,
    );
    expect(result.states.a.status).toBe('error');
    expect(result.states.c.status).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('pack 输出有硬问题 → 状态 ok 但带 warning（最多 3 条）', async () => {
    const { deps } = harness({
      runPack: async () => ({
        text: 'x',
        issues: [
          { code: 'a', where: 'p', message: '第 1 条' },
          { code: 'b', where: 'p', message: '第 2 条' },
          { code: 'c', where: 'p', message: '第 3 条' },
          { code: 'd', where: 'p', message: '第 4 条' },
        ],
      }),
    });
    const result = await executeWorkflow(
      [node('a', 'source', { text: 'x' }), node('b', 'pack'), node('c', 'output')],
      [edge('a', 'b'), edge('b', 'c')],
      deps,
    );
    expect(result.states.b.status).toBe('ok');
    expect(result.states.b.warning).toContain('4 处不合格');
    expect(result.states.b.warning).toContain('第 3 条');
    expect(result.states.b.warning).not.toContain('第 4 条');
  });
});

describe('成本闸门（判据 3）', () => {
  const chain: ExecNode[] = [
    node('a', 'source', { text: '提示词' }),
    node('img', 'image', { modelId: 'cogview-3-flash' }),
    node('out', 'output'),
  ];
  const edges = [edge('a', 'img'), edge('img', 'out')];

  it('未确认 → 生图节点零请求，状态 skipped，下游也 skipped', async () => {
    const { calls, deps } = harness({
      quote: () => quote,
      confirm: async () => false,
    });
    const result = await executeWorkflow(chain, edges, deps);

    expect(calls).toEqual([]);
    expect(result.states.img.status).toBe('skipped');
    expect(result.states.img.error).toContain('未确认本次花费');
    expect(result.declined).toEqual(['img']);
    expect(result.states.out.status).toBe('skipped');
  });

  it('确认后 → 恰好一次请求', async () => {
    const { calls, deps } = harness({
      quote: () => quote,
      confirm: async () => true,
    });
    const result = await executeWorkflow(chain, edges, deps);

    expect(calls).toEqual(['image:img']);
    expect(result.states.img.status).toBe('ok');
    expect(result.states.out.status).toBe('ok');
    expect(result.outputs.out?.media?.url).toBe('blob:image');
  });

  it('quote 为 null（没选模型）→ 不问、交给处理器报错', async () => {
    const asked: string[] = [];
    const { calls, deps } = harness({
      quote: () => null,
      confirm: async (q) => {
        asked.push(q.nodeId);
        return true;
      },
    });
    await executeWorkflow(chain, edges, deps);
    expect(asked).toEqual([]);
    expect(calls).toEqual(['image:img']);
  });
});

describe('停止（判据 4）', () => {
  it('第 2 个节点运行中停止 → 第 3 个 skipped，且在途结果被丢弃', async () => {
    let stopped = false;
    const { calls, deps } = harness({
      runPack: async () => {
        calls.push('pack:b');
        stopped = true; // 模拟用户在这个节点运行中点「停止」
        return { text: '迟到结果' };
      },
      isStopped: () => stopped,
    });

    const result = await executeWorkflow(
      [node('a', 'source', { text: 'x' }), node('b', 'pack'), node('c', 'output')],
      [edge('a', 'b'), edge('b', 'c')],
      deps,
    );

    expect(calls).toEqual(['pack:b']);
    expect(result.stopped).toBe(true);
    expect(result.states.b.status).toBe('skipped');
    expect(result.states.b.error).toContain('结果已丢弃');
    expect(result.states.c.status).toBe('skipped');
    expect(result.outputs.c).toBeUndefined();
  });

  it('停止发生在费用确认阶段 → 不发请求', async () => {
    let stopped = false;
    const { calls, deps } = harness({
      quote: () => quote,
      confirm: async () => {
        stopped = true;
        return true;
      },
      isStopped: () => stopped,
    });
    const result = await executeWorkflow(
      [node('a', 'source', { text: 'x' }), node('img', 'image', { modelId: 'm' })],
      [edge('a', 'img')],
      deps,
    );
    expect(calls).toEqual([]);
    expect(result.states.img.status).toBe('skipped');
  });
});

describe('视频节点', () => {
  it('视频走 runVideo，产物进 output（media kind = video）', async () => {
    const { calls, deps } = harness({
      quote: () => ({ ...quote, kind: 'video', nodeId: 'vid', spec: '5 秒 · 480p' }),
      confirm: async () => true,
    });
    const result = await executeWorkflow(
      [node('a', 'source', { text: '分镜' }), node('vid', 'video', { modelId: 'cogvideox-flash' }), node('out', 'output')],
      [edge('a', 'vid'), edge('vid', 'out')],
      deps,
    );
    expect(calls).toEqual(['video:vid']);
    expect(result.outputs.out?.media?.kind).toBe('video');
  });
});
