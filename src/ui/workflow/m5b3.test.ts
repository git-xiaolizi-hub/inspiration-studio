/**
 * M5b3 的回归：模板载入后"边能不能画出来"这件事，jsdom 能验的那一半。
 *
 * 真机上的根因是**渲染层**（节点没被测量 → `getEdgePosition` 拿到 null → EdgeWrapper 返回 null
 * → 节点在、边全没、控制台不报错），用 jsdom 断言不到 DOM 里有几条 `.react-flow__edge`。
 * 所以这里守两条**数据层能抓住、并且一旦破了真机上必定不画**的不变量：
 *
 * 1. 边两端的 `source/target` 必须是**载入后生成的节点 id**（不是模板里的 key `source`/`dream`）；
 * 2. 边两端的 `sourceHandle/targetHandle` 必须是那两个节点端口表里真实存在的 handle 名
 *    —— xyflow 就是按 `handleBounds.source[].id === edge.sourceHandle` 找端口的，找不到就整条不画。
 *
 * 浏览器层的断言在 `npm run check:edges`（scripts/check-edges.mjs）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { unmeasuredNodeIds } from './canvas-measure';
import { portsOf } from './ports';
import { useWorkflowStore } from './store';
import { WORKFLOW_TEMPLATES } from './templates';

const EXPECTED: Record<string, { nodes: number; edges: number }> = {
  'dream-to-image': { nodes: 4, edges: 3 },
  'copy-to-video': { nodes: 4, edges: 3 },
  'idea-to-text': { nodes: 3, edges: 2 },
  // M5b4：含「图片源」的模板（imageSource → 生视频的首帧口）
  'image-to-video': { nodes: 4, edges: 3 },
};

describe('M5b3 模板载入后连线必须可渲染（数据层判据）', () => {
  beforeEach(() => {
    useWorkflowStore.getState().reset();
  });

  it.each(WORKFLOW_TEMPLATES.map((template) => [template.id, template] as const))(
    '%s：边的两端都是真实节点 id，端口名与节点 handle 一一对应',
    (id, template) => {
      const want = EXPECTED[id];
      expect(want).toBeDefined();

      useWorkflowStore.getState().applyTemplate(template);

      const { nodes, edges } = useWorkflowStore.getState();
      expect(nodes).toHaveLength(want.nodes);
      expect(edges).toHaveLength(want.edges);

      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const edge of edges) {
        // 判据 5：边引用的是模板 key 而不是生成后的节点 id 时，这里会红
        expect(byId.has(edge.source), `边的 source ${edge.source} 不在画布节点里`).toBe(true);
        expect(byId.has(edge.target), `边的 target ${edge.target} 不在画布节点里`).toBe(true);
        expect(edge.source).toMatch(/^node_/);
        expect(edge.target).toMatch(/^node_/);

        // 自定义边类型：丢了就会被 xyflow 当未知类型处理
        expect(edge.type).toBe('workflow');

        const sourceNode = byId.get(edge.source);
        const targetNode = byId.get(edge.target);
        const sourcePorts = portsOf(sourceNode?.type ?? '').outputs.map((port) => port.name);
        const targetPorts = portsOf(targetNode?.type ?? '').inputs.map((port) => port.name);

        // 判据 2：handle 名对不上 → xyflow 找不到端口 → 整条边静默不画
        expect(sourcePorts, `${id}: ${sourceNode?.type} 没有输出口 ${edge.sourceHandle}`).toContain(
          edge.sourceHandle,
        );
        expect(targetPorts, `${id}: ${targetNode?.type} 没有输入口 ${edge.targetHandle}`).toContain(
          edge.targetHandle,
        );
      }

      // 判据 3：id 撞车会让后面的边顶掉前面的
      expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
      expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
    },
  );

  it('四个模板连续载入后，画布上只有最后那个模板的边（不残留上一条）', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      useWorkflowStore.getState().applyTemplate(template);
      const { nodes, edges } = useWorkflowStore.getState();
      const ids = new Set(nodes.map((node) => node.id));
      expect(edges).toHaveLength(EXPECTED[template.id].edges);
      expect(edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    }
  });
});

describe('M5b3 补测节点尺寸的挑选逻辑', () => {
  it('只挑没有 measured.width/height 的节点（含 lookup 里还没有的）', () => {
    const lookup = new Map<string, { measured?: { width?: number; height?: number } } | undefined>([
      ['a', { measured: { width: 220, height: 194 } }],
      ['b', { measured: {} }],
      ['c', { measured: { width: 0, height: 0 } }],
      ['d', undefined],
    ]);
    const picked = unmeasuredNodeIds(['a', 'b', 'c', 'd'], {
      get: (id) => lookup.get(id) as { measured?: { width?: number } } | undefined,
    });
    // a 已量过 → 跳过；b/c 没量到 → 补；d 还不在 lookup 里 → 也交给 updateNodeInternals（它会自己跳过不存在的）
    expect(picked).toEqual(['b', 'c', 'd']);
  });

  it('全都量过时返回空数组（正常环境下补测等于空转）', () => {
    const lookup = new Map([['a', { measured: { width: 220, height: 194 } }]]);
    expect(unmeasuredNodeIds(['a'], { get: (id) => lookup.get(id) as never })).toEqual([]);
  });
});
