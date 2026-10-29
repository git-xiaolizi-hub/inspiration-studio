/**
 * M5b4（可指定模型 / 中间产物可审核 / 图片与视频源）的九条判据。
 *
 * 为什么单独一个文件：任务书 §5 的九条要能在报告里**一条一条指过去**，
 * 而不是在一堆旧用例里找。执行器侧全部走 mock（零请求、零费用），
 * 只有"图片源读 artifacts"这一条用真 IndexedDB（fake-indexeddb）验证引用链。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { OFFICIAL_PRICE_TABLE } from '../../adapters/ai-models/pricing';
import { FREE_CHANNEL_CAPABILITIES, PAID_CHANNEL_CAPABILITIES } from '../../adapters/video/capabilities';
import { adapterForModel as videoAdapterForModel } from '../../adapters/video/channels';
import { saveArtifact } from '../../core/artifacts';
import { putRecord } from '../../core/storage';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import { executeWorkflow } from './executor';
import type { CostQuote, ExecuteDeps } from './executor';
import { checkConnection, subgraphTo, validateWorkflowGraph } from './graph';
import type { AICatalog } from '../../adapters/ai-models/catalog';
import { resolveTextModel } from './models';
import { createNodeHandlers } from './WorkflowRuntime';
import {
  IMAGE_SOURCE_MAX_BYTES,
  checkSourceFile,
  checkSourceFileSize,
  listSourceOptions,
  resolveSourceMedia,
  storeSourceFile,
} from './sources';
import type { ExecEdge, ExecNode } from './types';

const node = (id: string, type: ExecNode['type'], data: ExecNode['data'] = {}): ExecNode => ({
  id,
  type,
  data,
});
const port = (source: string, sourcePort: string, target: string, targetPort: string): ExecEdge => ({
  source,
  target,
  sourceHandle: sourcePort,
  targetHandle: targetPort,
});

interface Harness {
  calls: string[];
  deps: ExecuteDeps;
}

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

const imageQuote: CostQuote = {
  nodeId: 'img',
  kind: 'image',
  amount: 0.35,
  modelId: 'cogview-3-flash',
  spec: '1 张',
  free: false,
  notices: [],
};

/* ------------------------------------------------------------------ */
/* 判据 1：pack 节点指定模型                                            */
/* ------------------------------------------------------------------ */

/** 两条连接、两套模型：用来证明"选了 A 就跑 A" */
function catalogFixture(): AICatalog {
  return {
    providers: [
      {
        id: 'prov',
        name: '示例厂',
        builtin: false,
        activeConnectionId: 'conn',
        connections: [
          {
            id: 'conn',
            label: '主连接',
            baseUrl: 'https://example.com/v1',
            apiKey: 'k',
            models: [
              { id: 'm1', displayName: '模型甲', modelId: 'model-a', caps: ['text'] },
              { id: 'm2', displayName: '模型乙', modelId: 'model-b', caps: ['text'] },
            ],
          },
        ],
      },
    ],
    updatedAt: 0,
  };
}

describe('判据 1：pack 节点可以指定模型（不再只有 packId）', () => {
  it('选了哪个就用哪个：runPack 发出去的 model 就是所选那个', async () => {
    const seen: string[] = [];
    const handlers = createNodeHandlers({
      catalog: catalogFixture(),
      priceTable: OFFICIAL_PRICE_TABLE,
      workflowId: 'wf-test',
      chatImpl: (async (_input, request) => {
        seen.push(request.model);
        return { success: true, content: '{"interpretation":"一段解读"}' };
      }) as typeof import('../../adapters/ai-models/client').chat,
    });

    // 执行器只把节点交给 runPack；模型覆盖发生在运行时（节点 data 里带着 providerId/modelId）
    const { calls, deps } = harness({
      runPack: (target, text) => handlers.runPack(target, text),
    });
    const result = await executeWorkflow(
      [
        node('s', 'source', { text: '一段梦' }),
        node('p', 'pack', { packId: 'dream-interpretation', providerId: 'prov', modelId: 'model-b' }),
      ],
      [port('s', 'text', 'p', 'text')],
      deps,
    );

    expect(calls).toEqual([]); // 走的是真实的 runPack，不是 mock
    expect(result.states.p.status).toBe('ok');
    expect(seen).toEqual(['model-b']);
  });

  it('解析层：指定了配置里没有的模型 → 抛可读错误（不静默用默认模型）', () => {
    const catalog = catalogFixture();
    expect(resolveTextModel(catalog, { providerId: 'prov', modelId: 'model-a' }).modelId).toBe('model-a');

    expect(() => resolveTextModel(catalog, { providerId: 'prov', modelId: 'ghost' })).toThrow(
      /没有文本模型「ghost」/,
    );
    expect(() => resolveTextModel(catalog, { providerId: 'not-exist', modelId: 'model-a' })).toThrow(
      /找不到/,
    );
    // 一个文本模型都没配：出错话也要能照着做
    expect(() => resolveTextModel({ providers: [], updatedAt: 0 }, {})).toThrow(/文本模型/);
  });
});

/* ------------------------------------------------------------------ */
/* 判据 2–5：每步确认                                                  */
/* ------------------------------------------------------------------ */

describe('判据 2：每步确认按顺序调用 onNodeDone', () => {
  it('三个节点的 onNodeDone 依次被调用，返回 continue 时顺序不变', async () => {
    const seen: string[] = [];
    const { calls, deps } = harness({
      onNodeDone: async (nodeId) => {
        seen.push(nodeId);
        return 'continue';
      },
    });

    const result = await executeWorkflow(
      [node('s', 'source', { text: 'x' }), node('p', 'pack'), node('o', 'output')],
      [port('s', 'text', 'p', 'text'), port('p', 'text', 'o', 'text')],
      deps,
    );

    expect(seen).toEqual(['s', 'p', 'o']);
    expect(result.order).toEqual(['s', 'p', 'o']);
    expect(calls).toEqual(['pack:p']);
    expect(Object.values(result.states).every((state) => state.status === 'ok')).toBe(true);
  });
});

describe('判据 3：返回 abort → 后续节点全部 skipped、零请求', () => {
  it('第一个节点后中止：后面的生图节点一个请求都不发', async () => {
    const { calls, deps } = harness({
      quote: () => imageQuote,
      confirm: async () => true,
      onNodeDone: async () => 'abort',
    });

    const result = await executeWorkflow(
      [
        node('s', 'source', { text: 'x' }),
        node('p', 'pack'),
        node('img', 'image', { modelId: 'cogview-3-flash' }),
      ],
      [port('s', 'text', 'p', 'text'), port('p', 'text', 'img', 'prompt')],
      deps,
    );

    expect(result.aborted).toBe(true);
    expect(result.stopped).toBe(true);
    expect(calls).toEqual([]);
    expect(result.states.s.status).toBe('ok');
    expect(result.states.p.status).toBe('skipped');
    expect(result.states.img.status).toBe('skipped');
    expect(result.states.p.error).toContain('已停止');
  });
});

describe('判据 4：返回 retry → 当前节点跑两次，下游仍只跑一次', () => {
  it('只重跑当前节点（同一份输入），下游节点不受影响', async () => {
    const seen: Array<{ nodeId: string; text: string }> = [];
    let retried = false;
    const { calls, deps } = harness({
      runPack: async (target, text) => {
        calls.push(`pack:${target.id}`);
        seen.push({ nodeId: target.id, text });
        return { text: `pack-out:${target.id}` };
      },
      onNodeDone: async (nodeId) => {
        if (nodeId === 'p1' && !retried) {
          retried = true;
          return 'retry';
        }
        return 'continue';
      },
    });

    const result = await executeWorkflow(
      [
        node('s', 'source', { text: '原始输入' }),
        node('p1', 'pack'),
        node('p2', 'pack'),
      ],
      [port('s', 'text', 'p1', 'text'), port('p1', 'text', 'p2', 'text')],
      deps,
    );

    expect(calls).toEqual(['pack:p1', 'pack:p1', 'pack:p2']);
    // 重跑用的是同一份输入（不是把上一次的输出接进去）
    expect(seen.filter((item) => item.nodeId === 'p1').map((item) => item.text)).toEqual([
      '原始输入',
      '原始输入',
    ]);
    expect(result.states.p1.status).toBe('ok');
    expect(result.states.p2.status).toBe('ok');
    // 下游只跑一次，且吃到的是当前节点**重跑后**的那份输出
    expect(seen.filter((item) => item.nodeId === 'p2')).toHaveLength(1);
    expect(seen.find((item) => item.nodeId === 'p2')?.text).toBe('pack-out:p1');
  });
});

describe('判据 5：生图 retry 时成本闸门被再次调用', () => {
  it('确认次数 = 2（重跑也要先确认花钱）', async () => {
    let confirms = 0;
    let retried = false;
    const { calls, deps } = harness({
      quote: () => imageQuote,
      confirm: async () => {
        confirms += 1;
        return true;
      },
      onNodeDone: async (nodeId) => {
        // 只让「生图」那一步重跑一次（文本源不是花钱的步骤）
        if (nodeId === 'img' && !retried) {
          retried = true;
          return 'retry';
        }
        return 'continue';
      },
    });

    await executeWorkflow(
      [node('s', 'source', { text: '画面' }), node('img', 'image', { modelId: 'cogview-3-flash' })],
      [port('s', 'text', 'img', 'prompt')],
      deps,
    );

    expect({ confirms, calls }).toEqual({ confirms: 2, calls: ['image:img', 'image:img'] });
  });
});

/* ------------------------------------------------------------------ */
/* 判据 6：图片源                                                      */
/* ------------------------------------------------------------------ */

describe('判据 6：图片源（从已有产物里选 / 上传超限提前拒绝）', () => {
  beforeEach(async () => {
    await destroyDatabase();
  });

  it('从 artifacts 选 → 输出指向该 artifactId（引用链走真 IndexedDB）', async () => {
    const artifact = await saveArtifact({
      id: 'image:src1',
      recordId: 'workflow:wf-test',
      kind: 'image',
      modelId: 'cogview-3-flash',
      cost: 0,
      payload: {
        prompt: '一片冰海',
        blobId: 'image-blob:src1',
        mimeType: 'image/png',
        size: 12,
        remoteUrl: 'https://example.com/a.png',
      },
    });
    await putRecord('media', {
      id: 'image-blob:src1',
      recordId: 'artifact:image:src1',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      mimeType: 'image/png',
      durationMs: 0,
      createdAt: Date.now(),
    });

    const options = await listSourceOptions('image');
    expect(options).toHaveLength(1);
    expect(options[0].key).toBe(`artifact:${artifact.id}`);
    expect(options[0].publicUrl).toBe('https://example.com/a.png');

    const { deps } = harness({ readSource: resolveSourceMedia });
    const result = await executeWorkflow(
      [
        node('src', 'imageSource', { sourceArtifactId: artifact.id }),
        node('out', 'output'),
      ],
      [port('src', 'image', 'out', 'image')],
      deps,
    );

    expect(result.states.src.status).toBe('ok');
    expect(result.outputs.src?.media?.artifactId).toBe(artifact.id);
    expect(result.outputs.out?.media?.artifactId).toBe(artifact.id);
    expect(result.outputs.out?.media?.kind).toBe('image');

    const direct = await resolveSourceMedia(node('src', 'imageSource', { sourceArtifactId: artifact.id }));
    expect(direct.artifactId).toBe(artifact.id);
    expect(direct.blobId).toBe('image-blob:src1');
    await closeDatabase();
  });

  it('上传超过 10MB → 提前拒绝（文案里写明上限，且一个字节都不写库）', async () => {
    const tooBig = { name: 'huge.png', size: IMAGE_SOURCE_MAX_BYTES + 1, type: 'image/png' };
    const problem = checkSourceFile('image', tooBig);
    expect(problem).toContain('10.0 MB');
    expect(checkSourceFileSize('image', IMAGE_SOURCE_MAX_BYTES)).toBeNull();

    await expect(
      storeSourceFile('image', {
        ...tooBig,
        arrayBuffer: async () => new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/不能超过 10\.0 MB/);

    // 视频源上限是 100MB（不是同一个数）
    expect(checkSourceFile('video', { name: 'v.mp4', size: 100 * 1024 * 1024, type: 'video/mp4' })).toBeNull();
    expect(checkSourceFileSize('video', 100 * 1024 * 1024 + 1)).toContain('100.0 MB');

    // 类型也要对：图片源不能放视频
    expect(checkSourceFile('image', { name: 'v.mp4', size: 1024, type: 'video/mp4' })).toContain('只能放图片');
  });
});

/* ------------------------------------------------------------------ */
/* 判据 7：referenceVideo 口的类型校验                                  */
/* ------------------------------------------------------------------ */

describe('判据 7：referenceVideo 口只接 video', () => {
  const videoNode = node('v', 'video', { modelId: 'doubao-seedance-2-5-260628' });

  it('video → referenceVideo 通过（端口存在且类型一致）', () => {
    const verdict = checkConnection(
      [node('src', 'videoSource'), videoNode],
      [],
      { source: 'src', target: 'v', sourceHandle: 'video', targetHandle: 'referenceVideo' },
    );
    expect(verdict).toEqual({ ok: true });

    // 整图校验也要过（提示词口另外接一个文本源）
    expect(() =>
      validateWorkflowGraph(
        [node('s', 'source', { text: '运镜' }), node('src', 'videoSource'), videoNode],
        [port('s', 'text', 'v', 'prompt'), port('src', 'video', 'v', 'referenceVideo')],
      ),
    ).not.toThrow();
  });

  it('image → referenceVideo 被拒（类型不匹配）', () => {
    const verdict = checkConnection(
      [node('img', 'imageSource'), videoNode],
      [],
      { source: 'img', target: 'v', sourceHandle: 'image', targetHandle: 'referenceVideo' },
    );
    expect(verdict.ok).toBe(false);
    expect((verdict as { message: string }).message).toContain('类型不匹配');

    expect(() =>
      validateWorkflowGraph(
        [node('s', 'source', { text: '运镜' }), node('img', 'imageSource'), videoNode],
        [port('s', 'text', 'v', 'prompt'), port('img', 'image', 'v', 'referenceVideo')],
      ),
    ).toThrow(/类型不匹配/);
  });
});

/* ------------------------------------------------------------------ */
/* 判据 8：智谱 + 参考视频 → 执行时可读错误（不是静默忽略）              */
/* ------------------------------------------------------------------ */

describe('判据 8：模型不支持参考视频时显式拒绝', () => {
  it('执行器：不调 runVideo，节点状态 error 且话能照着做', async () => {
    const { calls, deps } = harness({
      quote: () => ({ ...imageQuote, kind: 'video', nodeId: 'v', spec: '5 秒 · 480p' }),
      confirm: async () => true,
      referenceVideoSupported: () => '当前模型（cogvideox-flash）不支持参考视频：请换方舟 Seedance，或移除「参考视频」那条连线',
    });

    const result = await executeWorkflow(
      [
        node('s', 'source', { text: '运镜' }),
        node('src', 'videoSource'),
        node('v', 'video', { modelId: 'cogvideox-flash' }),
      ],
      [port('s', 'text', 'v', 'prompt'), port('src', 'video', 'v', 'referenceVideo')],
      { ...deps, readSource: async () => ({ kind: 'video', url: 'blob:v', mimeType: 'video/mp4' }) },
    );

    expect(calls).toEqual([]);
    expect(result.states.v.status).toBe('error');
    expect(result.states.v.error).toContain('不支持参考视频');
    expect(result.states.v.error).toContain('Seedance');
  });

  it('运行时：能力来自适配器（智谱 false / 方舟 true），文案指向"换模型或移除连线"', () => {
    const catalog = catalogFixture();
    const freeHandlers = createNodeHandlers({
      catalog,
      priceTable: OFFICIAL_PRICE_TABLE,
      workflowId: 'wf-test',
      videoAdapterFor: ((model: { modelId: string }) => ({
        ok: true,
        kind: 'zhipu',
        adapter: {} as never,
        capabilities: FREE_CHANNEL_CAPABILITIES,
        free: true,
        priceTable: OFFICIAL_PRICE_TABLE,
        priceModel: model.modelId,
      })) as unknown as typeof videoAdapterForModel,
    });
    const blocked = freeHandlers.referenceVideoSupported(
      node('v', 'video', { modelId: 'cogvideox-flash', vendorId: 'prov' }),
    );
    expect(blocked).toContain('不支持参考视频');
    expect(blocked).toContain('移除「参考视频」那条连线');

    const paidHandlers = createNodeHandlers({
      catalog,
      priceTable: OFFICIAL_PRICE_TABLE,
      workflowId: 'wf-test',
      videoAdapterFor: ((model: { modelId: string }) => ({
        ok: true,
        kind: 'ark',
        adapter: {} as never,
        capabilities: PAID_CHANNEL_CAPABILITIES,
        free: false,
        priceTable: OFFICIAL_PRICE_TABLE,
        priceModel: model.modelId,
      })) as unknown as typeof videoAdapterForModel,
    });
    expect(
      paidHandlers.referenceVideoSupported(
        node('v', 'video', { modelId: 'doubao-seedance-2-5-260628', vendorId: 'prov' }),
      ),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 判据 9：「运行到此节点」只跑祖先链                                   */
/* ------------------------------------------------------------------ */

describe('判据 9：运行到此节点 = 只跑它的祖先链', () => {
  it('兄弟分支不在结果里（保持 idle、零请求）', async () => {
    const allNodes: ExecNode[] = [
      node('s', 'source', { text: 'x' }),
      node('a', 'pack'),
      node('b', 'pack'),
      node('sibling', 'pack'),
    ];
    const allEdges: ExecEdge[] = [
      port('s', 'text', 'a', 'text'),
      port('a', 'text', 'b', 'text'),
      port('s', 'text', 'sibling', 'text'),
    ];

    const sub = subgraphTo('b', allNodes, allEdges);
    expect(sub.nodes.map((item) => item.id)).toEqual(['s', 'a', 'b']);
    expect(sub.edges).toHaveLength(2);

    const { calls, deps } = harness();
    const result = await executeWorkflow(sub.nodes, sub.edges, deps);

    expect(calls).toEqual(['pack:a', 'pack:b']);
    expect(calls).not.toContain('pack:sibling');
    // 兄弟分支根本没进这次执行 → 状态仍是 idle（页面不会把它点亮成"跑过"）
    expect(result.states.sibling?.status ?? 'idle').toBe('idle');
    expect(result.states.b.status).toBe('ok');
  });

  it('目标节点不在画布上 → 抛可读错误（不静默跑空）', () => {
    expect(() => subgraphTo('ghost', [node('s', 'source')], [])).toThrow(/不在画布上/);
  });
});
