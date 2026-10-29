/**
 * 三个内置模板（M5b2 §5）。
 *
 * 为什么是代码里的常量而不是拉下来的 JSON：**不联网**是这一层唯一的硬要求。
 * 模板是新手入口（ComfyUI 的 Workflow Templates、RunningHub 的"一键运行或修改"都是同一个
 * 思路），所以每个模板只给一句人话说明，不给参数面板 —— 参数留给节点自己。
 *
 * 模板里的边**显式带端口名**：从模板载入的图不应该靠"兜底推断"才成立。
 */

import { createNodeId } from './db';
import type { WFEdge, WFNode, WFNodeData, WFNodeType } from './types';

export interface TemplateNode {
  /** 模板内的局部 id（只用于连边，载入时换成真正节点 id） */
  key: string;
  type: WFNodeType;
  position: { x: number; y: number };
  data: WFNodeData;
  /** 节点上的一句话说明（载入后写进 `text` 的种子内容用 data，不用这个） */
}

export interface TemplateEdge {
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
}

export interface WorkflowTemplate {
  id: string;
  title: string;
  /** 一句话人话说明（卡片上就显示它） */
  description: string;
  /** 跑起来大概几步、花不花钱 —— 用户点之前该知道的 */
  note: string;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
}

const DREAM_SEED =
  '我梦见自己站在一片没有边的海上，脚下是冰，远处有一盏一直不灭的灯。冰面偶尔发出裂开的声音。';

const IDEA_SEED = '一个只在雨夜营业的修表铺，店主能修好别人的时间，却修不好自己的表。';

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'dream-to-image',
    title: '解梦 → 故事 → 生图',
    description: '想把这个梦变成画面：先解梦，再把意象写成画面描述，最后出一张图。',
    note: '3 次文本/图像请求；生图那一步会先弹费用确认',
    nodes: [
      { key: 'source', type: 'source', position: { x: 40, y: 140 }, data: { text: DREAM_SEED } },
      {
        key: 'dream',
        type: 'pack',
        position: { x: 320, y: 140 },
        data: { packId: 'dream-interpretation' },
      },
      {
        key: 'story',
        type: 'pack',
        position: { x: 600, y: 140 },
        data: { packId: 'story-expansion' },
      },
      { key: 'image', type: 'image', position: { x: 880, y: 140 }, data: { promptFromUpstream: true } },
    ],
    edges: [
      { source: 'source', target: 'dream', sourcePort: 'text', targetPort: 'text' },
      { source: 'dream', target: 'story', sourcePort: 'text', targetPort: 'text' },
      { source: 'story', target: 'image', sourcePort: 'text', targetPort: 'prompt' },
    ],
  },
  {
    id: 'copy-to-video',
    title: '文案 → 分镜 → 生视频',
    description: '手里已经有一句文案：先优化成画面描述，再拆成分镜，最后出一段视频。',
    note: '4 次请求（含视频排队）；视频按秒计费，确认框会写清规格',
    nodes: [
      { key: 'source', type: 'source', position: { x: 40, y: 140 }, data: { text: IDEA_SEED } },
      {
        key: 'optimizer',
        type: 'pack',
        position: { x: 320, y: 140 },
        data: { packId: 'image-prompt-optimizer' },
      },
      {
        key: 'storyboard',
        type: 'pack',
        position: { x: 600, y: 140 },
        data: { packId: 'video-storyboard' },
      },
      {
        key: 'video',
        type: 'video',
        position: { x: 880, y: 140 },
        data: { promptFromUpstream: true, resolution: '480p', durationSec: 5 },
      },
    ],
    edges: [
      { source: 'source', target: 'optimizer', sourcePort: 'text', targetPort: 'text' },
      { source: 'optimizer', target: 'storyboard', sourcePort: 'text', targetPort: 'text' },
      { source: 'storyboard', target: 'video', sourcePort: 'text', targetPort: 'prompt' },
    ],
  },
  {
    id: 'idea-to-text',
    title: '灵感 → 扩写 → 输出',
    description: '先把一句灵感写成完整的一段，直接在「输出」节点里读、下载。',
    note: '1 次文本请求（最便宜的一个模板）',
    nodes: [
      { key: 'source', type: 'source', position: { x: 40, y: 140 }, data: { text: IDEA_SEED } },
      {
        key: 'story',
        type: 'pack',
        position: { x: 320, y: 140 },
        data: { packId: 'story-expansion' },
      },
      { key: 'output', type: 'output', position: { x: 600, y: 140 }, data: {} },
    ],
    edges: [
      { source: 'source', target: 'story', sourcePort: 'text', targetPort: 'text' },
      { source: 'story', target: 'output', sourcePort: 'text', targetPort: 'text' },
    ],
  },
  {
    /**
     * M5b4：**含「图片源」的模板**。
     *
     * 为什么单开一个而不是改进现有模板：现有三个模板是"从文本开始"的完整链路，
     * 塞一张图进去会让新用户以为"必须先有图"；这个模板专门回答"我已经有图了，怎么动起来"。
     * 顺带成为 `check:edges` 里"图片源节点的边也能画出来"的真浏览器断言。
     */
    id: 'image-to-video',
    title: '已有图片 → 生视频',
    description: '手里已经有一张图：把图接到「生视频」的首帧，写一句运镜描述，出一段视频。',
    note: '1 次文本请求 + 1 次视频（视频按秒计费，确认框会写清规格）',
    nodes: [
      { key: 'source', type: 'source', position: { x: 40, y: 60 }, data: { text: IDEA_SEED } },
      {
        key: 'imageSource',
        type: 'imageSource',
        position: { x: 40, y: 300 },
        data: {},
      },
      {
        key: 'video',
        type: 'video',
        position: { x: 380, y: 140 },
        data: { promptFromUpstream: true, resolution: '480p', durationSec: 5 },
      },
      { key: 'output', type: 'output', position: { x: 700, y: 140 }, data: {} },
    ],
    edges: [
      { source: 'source', target: 'video', sourcePort: 'text', targetPort: 'prompt' },
      { source: 'imageSource', target: 'video', sourcePort: 'image', targetPort: 'firstFrame' },
      { source: 'video', target: 'output', sourcePort: 'video', targetPort: 'video' },
    ],
  },
];

/** 模板 → 真实节点/边（纯函数：测试直接断言数量，页面直接用） */
export function instantiateTemplate(
  template: WorkflowTemplate,
  nextId: () => string = createNodeId,
): { nodes: WFNode[]; edges: WFEdge[] } {
  const idOf = new Map<string, string>();
  for (const node of template.nodes) idOf.set(node.key, nextId());

  const nodes: WFNode[] = template.nodes.map((node) => ({
    id: idOf.get(node.key) as string,
    type: node.type,
    position: { ...node.position },
    data: { ...node.data },
  }));

  const edges: WFEdge[] = template.edges.map((edge) => {
    const source = idOf.get(edge.source) as string;
    const target = idOf.get(edge.target) as string;
    return {
      id: `edge_${source}_${edge.sourcePort}_${target}_${edge.targetPort}`,
      source,
      target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
    };
  });

  return { nodes, edges };
}

export function findTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id);
}
