/**
 * 工作向画板的数据模型（M5b）。
 *
 * 与 `@xyflow/react` 的类型**刻意分开**：这里是"存进 IndexedDB 的东西"，
 * 形状由任务书 §2 钉死；xyflow 的 `Node`/`Edge` 是"渲染时的东西"，带
 * `measured`/`selected`/`dragging` 等运行期字段，不能写进库。
 * 两者之间只有两个方向的转换（`toFlowNode` / `toStoredNode`，见 `store.ts`）。
 */

/** M5b2 新增 `merge`（文本合并）：多对一必须靠显式节点，不做隐式合并（§1 调研） */
/** M5b4 新增 `imageSource` / `videoSource`：用已有图片/视频当输入（不再是"只有文本源"） */
export type WFNodeType =
  | 'source'
  | 'merge'
  | 'pack'
  | 'image'
  | 'video'
  | 'imageSource'
  | 'videoSource'
  | 'output';

/** 运行期状态：**不持久化**（刷新后一律回落 idle，见 `serializeWorkflow`） */
export type WFStatus = 'idle' | 'running' | 'ok' | 'error' | 'skipped';

/** 四份 prompt-pack（`packs/` 下的目录名，逐字一致） */
export type PackId =
  | 'dream-interpretation'
  | 'story-expansion'
  | 'image-prompt-optimizer'
  | 'video-storyboard';

export const PACK_IDS: readonly PackId[] = [
  'dream-interpretation',
  'story-expansion',
  'image-prompt-optimizer',
  'video-storyboard',
];

export const PACK_LABELS: Record<PackId, string> = {
  'dream-interpretation': '解梦',
  'story-expansion': '灵感与文案',
  'image-prompt-optimizer': '生图提示词优化',
  'video-storyboard': '视频分镜',
};

export const NODE_TYPE_LABELS: Record<WFNodeType, string> = {
  source: '文本源',
  merge: '文本合并',
  pack: '提示词包',
  image: '生图',
  video: '生视频',
  imageSource: '图片源',
  videoSource: '视频源',
  output: '输出',
};

/** 「文本合并」的默认分隔符（任务书 §2.3） */
export const MERGE_SEPARATOR = '\n\n';

export interface WFNodeData {
  /* ---- source ---- */
  /** 绑定的记录；有值时执行器优先读记录正文 */
  recordId?: string;
  /** 手写文本（没有 recordId 时用它） */
  text?: string;
  /* ---- merge ---- */
  /** 拼接分隔符，默认 `\n\n` */
  separator?: string;
  /** true = 给每段加 `【素材N】` 标签 */
  labelParts?: boolean;
  /* ---- pack ---- */
  packId?: PackId;
  /**
   * M5b4：这个「提示词包」节点由哪个模型跑（空 = 跟随当前默认文本模型）。
   * 存在 `WFNodeData` 上而不是全局设置上：一个画板上两个 pack 节点可以用不同模型。
   */
  providerId?: string;
  /**
   * 这个节点所在的 pack 有一份自定义副本时记下它的 id —— 节点上的「自定义」角标靠它。
   * 只影响显示：真正生效的是 `core/custom-prompts` 里"按 packId 解析"的当前副本，
   * 所以副本被删掉后即使这里还留着旧 id，跑的仍是内置正文（角标由面板里的操作同步清掉）。
   */
  customPromptId?: string;
  /* ---- imageSource / videoSource（M5b4） ---- */
  /** 从已有产物里选的：artifacts 表那条的 id（图片） */
  sourceArtifactId?: string;
  /** 从本地文件上传的：media 表那条的主键 */
  sourceMediaId?: string;
  /** 节点上要显示的文件名与体积（上传时记下来，刷新后还在） */
  fileName?: string;
  fileSize?: number;
  /* ---- image / video ---- */
  vendorId?: string;
  modelId?: string;
  /** true（默认）= 用上游文本当提示词；false = 用节点自己的 text */
  promptFromUpstream?: boolean;
  /** 视频参数（可选；缺省 480p / 5 秒） */
  resolution?: '480p' | '720p' | '1080p';
  durationSec?: number;
  /* ---- 运行期（不持久化） ---- */
  status?: WFStatus;
  error?: string;
  /** 校验器的硬问题（最多显示 3 条），状态仍是 ok */
  warning?: string;
  /* ---- output 节点的预览（运行期，不持久化） ---- */
  resultText?: string;
  mediaUrl?: string;
  mediaKind?: 'image' | 'video';
  /** 产物 id（图片落盘后 artifacts 表里的那条） */
  artifactId?: string;
}

/** 从已有产物 / 本地文件取来的素材（M5b4）：节点里只存引用，不存 base64 */
export interface SourceSelection {
  /** artifacts 表那条（从"已有产物"里选时） */
  sourceArtifactId?: string;
  /** media 表那条（本地文件上传时） */
  sourceMediaId?: string;
  fileName?: string;
  fileSize?: number;
}

export interface WFNode {
  id: string;
  type: WFNodeType;
  position: { x: number; y: number };
  data: WFNodeData;
}

export interface WFEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WFNode[];
  edges: WFEdge[];
  createdAt: number;
  updatedAt: number;
}

/** 执行器只关心这三个字段；xyflow 的节点天然满足 */
export interface ExecNode {
  id: string;
  type: string;
  data: WFNodeData;
}

export interface ExecEdge {
  source: string;
  target: string;
  /** M5b2：端口名。老数据可能没有 —— 由 `resolveEdges` 兜底推断 */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export function isWFNodeType(value: unknown): value is WFNodeType {
  return (
    value === 'source' ||
    value === 'merge' ||
    value === 'pack' ||
    value === 'image' ||
    value === 'video' ||
    value === 'imageSource' ||
    value === 'videoSource' ||
    value === 'output'
  );
}

export function isPackId(value: unknown): value is PackId {
  return typeof value === 'string' && (PACK_IDS as readonly string[]).includes(value);
}

/** 新节点的默认 data（数值参数给保守默认值：视频 480p / 5 秒 = 最便宜的一档） */
export function defaultNodeData(type: WFNodeType): WFNodeData {
  if (type === 'pack') return { packId: 'dream-interpretation' };
  if (type === 'merge') return { separator: MERGE_SEPARATOR, labelParts: false };
  if (type === 'image') return { promptFromUpstream: true };
  if (type === 'video') return { promptFromUpstream: true, resolution: '480p', durationSec: 5 };
  if (type === 'source') return { text: '' };
  if (type === 'imageSource' || type === 'videoSource') return {};
  return {};
}
