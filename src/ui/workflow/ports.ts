/**
 * 类型化端口（M5b2 §2.1）。
 *
 * 为什么要分类型：ComfyUI 的官方文档把"链接按数据类型校验"写成第一条（"Only compatible
 * data types can be connected"）。如果不分类型，用户可以把一张图接到提示词口上，
 * 运行时只会得到一句莫名其妙的"没有提示词"——错在连线那一刻，就该在那一刻拒绝。
 *
 * 四条连接规则（§2.2，`graph.ts` 的 `resolveEdges` 逐条实现）：
 * 1. **类型必须一致**：`text → image` 拒绝，提示「类型不匹配：文本不能接到图片口」；
 * 2. **同一个输入口最多一条线**（ComfyUI 也这样）；要合并请加「文本合并」节点；
 * 3. **一个输出可以接任意多个下游**（一对多 ✅）——执行器缓存上游结果，只跑一次；
 * 4. **多对多**是上面几条的自然结果；有环仍然报错。
 *
 * 端口名（`PortDef.name`）同时是 xyflow 的 handle id —— 连线两侧都必须带 handle id，
 * 否则"接到哪个口"就丢了。老数据（M5b 存的边没有 handle）由 `resolveEdges` 的兜底
 * 推断兼容：只有一个输出口就取它，输入口取**第一个类型相同的**口。
 */

import type { WFNodeType } from './types';

export type PortType = 'text' | 'image' | 'video';

export interface PortDef {
  /** handle id，同时是执行器取值的键 */
  name: string;
  type: PortType;
  /** 界面上的短标签 */
  label: string;
  required?: boolean;
}

export interface NodePorts {
  inputs: PortDef[];
  outputs: PortDef[];
}

const TEXT_OUT: PortDef[] = [{ name: 'text', type: 'text', label: '文本' }];

/**
 * 端口表（报告 §1 的那张表的代码形态）。
 *
 * 「输出」节点给了三个**分类型**的输入口而不是一个万能口：
 * - 需要"同时导入文本与图片"时，两条线落在不同口上，互不冲突；
 * - 规则 2（一个口最多一条线）因此不用开口子；
 * - 类型检查照常生效（图不能接到文本口）。
 */
export const NODE_PORTS: Record<WFNodeType, NodePorts> = {
  source: { inputs: [], outputs: TEXT_OUT },
  imageSource: {
    inputs: [],
    outputs: [{ name: 'image', type: 'image', label: '图片' }],
  },
  videoSource: {
    inputs: [],
    outputs: [{ name: 'video', type: 'video', label: '视频' }],
  },
  merge: {
    inputs: [
      { name: 'text1', type: 'text', label: '素材 1', required: true },
      { name: 'text2', type: 'text', label: '素材 2', required: true },
      { name: 'text3', type: 'text', label: '素材 3' },
      { name: 'text4', type: 'text', label: '素材 4' },
    ],
    outputs: TEXT_OUT,
  },
  pack: {
    inputs: [{ name: 'text', type: 'text', label: '文本', required: true }],
    outputs: TEXT_OUT,
  },
  image: {
    inputs: [
      { name: 'prompt', type: 'text', label: '提示词', required: true },
      { name: 'reference', type: 'image', label: '参考图' },
    ],
    outputs: [{ name: 'image', type: 'image', label: '图片' }],
  },
  video: {
    inputs: [
      { name: 'prompt', type: 'text', label: '提示词', required: true },
      { name: 'firstFrame', type: 'image', label: '首帧图' },
      // M5b4：参考视频（video → video）。能力裁剪在适配器层判定，执行器显式拒绝而不是静默忽略。
      { name: 'referenceVideo', type: 'video', label: '参考视频' },
    ],
    outputs: [{ name: 'video', type: 'video', label: '视频' }],
  },
  output: {
    inputs: [
      { name: 'text', type: 'text', label: '文本' },
      { name: 'image', type: 'image', label: '图片' },
      { name: 'video', type: 'video', label: '视频' },
    ],
    outputs: [],
  },
};

export const PORT_TYPE_LABELS: Record<PortType, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
};

export function portsOf(type: string): NodePorts {
  return NODE_PORTS[type as WFNodeType] ?? { inputs: [], outputs: [] };
}

export function findInput(type: string, name: string | null | undefined): PortDef | undefined {
  if (!name) return undefined;
  return portsOf(type).inputs.find((port) => port.name === name);
}

export function findOutput(type: string, name: string | null | undefined): PortDef | undefined {
  if (!name) return undefined;
  return portsOf(type).outputs.find((port) => port.name === name);
}

/** 连线被拒时给用户的一句话（规则 1） */
export function typeMismatchMessage(from: PortType, to: PortType): string {
  return `类型不匹配：${PORT_TYPE_LABELS[from]}不能接到${PORT_TYPE_LABELS[to]}口`;
}
