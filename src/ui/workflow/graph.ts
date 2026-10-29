/**
 * 图的校验与排序（M5b2：DAG + 类型化端口）。
 *
 * M5b 的"必须是一条单链"被委托人否掉了（原话：**连线不能一对多、多对一、多对多**）。
 * 这一版把图放宽成 DAG，同时把"能连什么"钉成五条可断言的规则：
 *
 * 1. 节点非空、id 不重复；边的两端节点必须存在、不自环、不重复；
 * 2. **类型必须一致**：`text` 的输出只能接到 `text` 的输入口（`ports.ts` 的端口表）；
 * 3. **同一个输入口最多一条线**：要合并请加「文本合并」节点（不做隐式合并）；
 * 4. **一个输出可以接任意多个下游**：一对多、多对多都是它的自然结果；
 * 5. **无环**（Kahn 排不完就是有环），且每个节点的**必填输入口**都连上了线
 *    —— 这条取代了 M5b 的"必须从文本源开始 / 必须一个出口"。
 *
 * 所有失败都抛 `WorkflowGraphError`，带机器可读的 `code`
 * —— 执行器靠它区分"图不合法"和"某个节点跑失败"。
 */

import { findInput, findOutput, portsOf, typeMismatchMessage } from './ports';
import type { PortType } from './ports';
import type { ExecEdge, ExecNode } from './types';

export type GraphErrorCode =
  | 'empty'
  | 'duplicate-node'
  | 'missing-node'
  | 'duplicate-edge'
  | 'self-loop'
  | 'cycle'
  | 'unknown-port'
  | 'type-mismatch'
  | 'port-busy'
  | 'missing-required-input';

export class WorkflowGraphError extends Error {
  readonly code: GraphErrorCode;

  constructor(code: GraphErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowGraphError';
    this.code = code;
  }
}

/** 端口解析后的边：执行器只认这个形状（handle 兜底推断已经做完） */
export interface ResolvedEdge {
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  type: PortType;
}

interface Index {
  ids: string[];
  typeOf: Map<string, string>;
  inDegree: Map<string, number>;
}

function nodeLabel(node: ExecNode): string {
  const type = node.type;
  const labels: Record<string, string> = {
    source: '文本源',
    merge: '文本合并',
    pack: '提示词包',
    image: '生图',
    video: '生视频',
    imageSource: '图片源',
    videoSource: '视频源',
    output: '输出',
  };
  return labels[type] ?? type;
}

function buildIndex(nodes: readonly ExecNode[], edges: readonly ExecEdge[]): Index {
  const ids = nodes.map((node) => node.id);
  if (ids.length === 0) {
    throw new WorkflowGraphError('empty', '画布是空的：先放一个「文本源」节点，或从模板开始');
  }
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    throw new WorkflowGraphError('duplicate-node', '有两个节点的 id 一样，工作流数据坏了');
  }

  const typeOf = new Map<string, string>();
  for (const node of nodes) typeOf.set(node.id, node.type);

  const inDegree = new Map<string, number>();
  for (const id of ids) inDegree.set(id, 0);

  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) {
      throw new WorkflowGraphError(
        'missing-node',
        `有一条连线指向不存在的节点（${edge.source} → ${edge.target}）`,
      );
    }
    if (edge.source === edge.target) {
      throw new WorkflowGraphError('self-loop', `节点 ${edge.source} 连到了自己：工作流有环，无法执行`);
    }
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  return { ids, typeOf, inDegree };
}

/**
 * 把边解析成"哪个口 → 哪个口"，顺带做规则 1/2/3 的检查。
 *
 * handle 的兜底推断（兼容 M5b 存下的老数据）：
 * - 输出口：节点只有一个输出口就取它；多个输出口时没写 handle 视为错误；
 * - 输入口：没写 handle 时取**第一个类型相同的**输入口（所以老的 `生图 → 输出`
 *   会自动落到「输出」的图片口，不会误判成类型不匹配）。
 */
export function resolveEdges(
  nodes: readonly ExecNode[],
  edges: readonly ExecEdge[],
): ResolvedEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const resolved: ResolvedEdge[] = [];
  const takenPorts = new Map<string, ResolvedEdge>();
  const seenExact = new Set<string>();

  for (const edge of edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) continue; // buildIndex 会报，这里只是防御

    const sourcePorts = portsOf(sourceNode.type).outputs;
    if (sourcePorts.length === 0) {
      throw new WorkflowGraphError(
        'unknown-port',
        `「${nodeLabel(sourceNode)}」没有输出口，不能往外连线`,
      );
    }
    const outPort = edge.sourceHandle
      ? findOutput(sourceNode.type, edge.sourceHandle)
      : sourcePorts.length === 1
        ? sourcePorts[0]
        : undefined;
    if (!outPort) {
      throw new WorkflowGraphError(
        'unknown-port',
        `「${nodeLabel(sourceNode)}」没有名为 ${edge.sourceHandle} 的输出口`,
      );
    }

    const inPort = edge.targetHandle
      ? findInput(targetNode.type, edge.targetHandle)
      : portsOf(targetNode.type).inputs.find((port) => port.type === outPort.type);
    if (!inPort) {
      if (edge.targetHandle === null || edge.targetHandle === undefined) {
        throw new WorkflowGraphError(
          'type-mismatch',
          typeMismatchMessage(outPort.type, portsOf(targetNode.type).inputs[0]?.type ?? 'text'),
        );
      }
      throw new WorkflowGraphError(
        'unknown-port',
        `「${nodeLabel(targetNode)}」没有名为 ${edge.targetHandle} 的输入口`,
      );
    }

    // 规则 1：类型必须一致
    if (inPort.type !== outPort.type) {
      throw new WorkflowGraphError('type-mismatch', typeMismatchMessage(outPort.type, inPort.type));
    }

    const exactKey = `${edge.source}:${outPort.name}->${edge.target}:${inPort.name}`;
    if (seenExact.has(exactKey)) {
      throw new WorkflowGraphError(
        'duplicate-edge',
        `同一条连线画了两遍（${edge.source} → ${edge.target}）`,
      );
    }
    seenExact.add(exactKey);

    // 规则 3：同一个输入口最多一条线
    const portKey = `${edge.target}:${inPort.name}`;
    const holder = takenPorts.get(portKey);
    if (holder) {
      throw new WorkflowGraphError(
        'port-busy',
        `「${nodeLabel(targetNode)}」的输入口「${inPort.label}」最多一条线` +
          `（已经接的是 ${holder.source}）；要合并多段文本请加一个「文本合并」节点`,
      );
    }

    const next: ResolvedEdge = {
      source: edge.source,
      target: edge.target,
      sourcePort: outPort.name,
      targetPort: inPort.name,
      type: outPort.type,
    };
    takenPorts.set(portKey, next);
    resolved.push(next);
  }

  return resolved;
}

/**
 * 单纯的 Kahn 拓扑排序（保持 `nodes` 里的相对顺序，结果稳定）。
 * 有环时抛 `cycle`；**不做端口校验**，供需要单独排序的调用方（与测试）使用。
 */
export function topoSort(nodes: readonly ExecNode[], edges: readonly ExecEdge[]): string[] {
  const ids = nodes.map((node) => node.id);
  if (ids.length === 0) throw new WorkflowGraphError('empty', '画布是空的');
  const idSet = new Set(ids);

  const inDegree = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    next.set(id, []);
  }
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) {
      throw new WorkflowGraphError('missing-node', `连线指向不存在的节点（${edge.source} → ${edge.target}）`);
    }
    next.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const target of next.get(id) ?? []) {
      const left = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, left);
      if (left === 0) queue.push(target);
    }
  }

  if (order.length !== ids.length) {
    throw new WorkflowGraphError('cycle', '工作流有环，无法执行');
  }
  return order;
}

/** 必填输入口有没有连上（规则 5 的后半句） */
function checkRequiredInputs(
  nodes: readonly ExecNode[],
  resolved: readonly ResolvedEdge[],
): void {
  const filled = new Set(resolved.map((edge) => `${edge.target}:${edge.targetPort}`));
  for (const node of nodes) {
    // 生图/生视频把「用上游文本当提示词」关掉后，prompt 口就不必填了
    const ownPrompt =
      (node.type === 'image' || node.type === 'video') && node.data.promptFromUpstream === false;
    for (const port of portsOf(node.type).inputs) {
      if (!port.required) continue;
      if (ownPrompt && port.name === 'prompt') continue;
      if (filled.has(`${node.id}:${port.name}`)) continue;
      throw new WorkflowGraphError(
        'missing-required-input',
        `「${nodeLabel(node)}」的必填输入口「${port.label}」没有连线（${port.type}）`,
      );
    }
  }
}

/**
 * 完整校验，返回**执行顺序**（拓扑序，同层保持 nodes 里的相对顺序）。
 * 失败抛 `WorkflowGraphError`；此时执行器不会调用任何节点处理器（零请求）。
 */
export function validateWorkflowGraph(
  nodes: readonly ExecNode[],
  edges: readonly ExecEdge[],
): string[] {
  buildIndex(nodes, edges);

  // 端口 / 类型 / 一口一线（规则 1–3）
  const resolved = resolveEdges(nodes, edges);

  // 有环（规则 5）：先排一次，报"有环"比报"某个口没连"更贴用户直觉
  const order = topoSort(nodes, edges);

  checkRequiredInputs(nodes, resolved);

  return order;
}

/** 连线时（拖拽落点那一刻）的单条校验：给 UI 用，不抛错，只回一句话 */
export function checkConnection(
  nodes: readonly ExecNode[],
  edges: readonly ExecEdge[],
  connection: { source?: string | null; target?: string | null; sourceHandle?: string | null; targetHandle?: string | null },
): { ok: true } | { ok: false; message: string } {
  const source = connection.source ?? '';
  const target = connection.target ?? '';
  if (source === '' || target === '') return { ok: false, message: '连线两端必须都是节点' };
  if (source === target) return { ok: false, message: '不能把节点连到自己' };

  const sourceNode = nodes.find((node) => node.id === source);
  const targetNode = nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode) return { ok: false, message: '连线两端必须都是节点' };

  const outPort = findOutput(sourceNode.type, connection.sourceHandle) ?? portsOf(sourceNode.type).outputs[0];
  const inPort = findInput(targetNode.type, connection.targetHandle);
  if (!outPort) return { ok: false, message: `「${nodeLabel(sourceNode)}」没有输出口` };
  if (!inPort) return { ok: false, message: `「${nodeLabel(targetNode)}」没有这个输入口` };

  if (outPort.type !== inPort.type) {
    return { ok: false, message: typeMismatchMessage(outPort.type, inPort.type) };
  }

  const busy = edges.find((edge) => edge.target === target && (edge.targetHandle ?? inPort.name) === inPort.name);
  if (busy) {
    return {
      ok: false,
      message:
        `「${nodeLabel(targetNode)}」的输入口「${inPort.label}」最多一条线` +
        '；要合并多段文本请加一个「文本合并」节点',
    };
  }

  return { ok: true };
}

/** 给人看的一句话（UI 与报告共用，避免两处文案不一致） */
export function describeGraphError(error: unknown): string {
  if (error instanceof WorkflowGraphError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「运行到此节点」（M5b4 §3.3）：把目标节点当终点，只留它的祖先。
 *
 * 为什么不做成"执行器支持部分执行"：执行器已经有"顺序 + 失败传播 + 单节点一次"三条性质，
 * 再塞一个"跑哪些"的开关会让它多一条分支。这里只把图**裁小**，执行器一行都不用改
 * —— 裁出来的图本身就是合法的 DAG（兄弟分支连同它们的边一起被拿掉）。
 *
 * 语义细节：
 * - 结果集合 = 目标节点 + 所有能从目标反向走到的祖先（**传递闭包**）；
 * - 边只保留两端都在集合里的（跨到兄弟分支的边本来就不存在，因为兄弟分支不在集合里）；
 * - 目标节点不在图里 → 抛 `missing-node`（不静默返回空图，否则"运行"会变成"什么都没做"）；
 * - 顺序按**原 nodes 顺序**，交给 `validateWorkflowGraph` 自己拓扑排序（保持既有语义）。
 */
export function subgraphTo(
  targetId: string,
  nodes: readonly ExecNode[],
  edges: readonly ExecEdge[],
): { nodes: ExecNode[]; edges: ExecEdge[] } {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  if (!nodeById.has(targetId)) {
    throw new WorkflowGraphError('missing-node', `要运行到的节点不在画布上（${targetId}）`);
  }

  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }

  const keep = new Set<string>([targetId]);
  const queue = [targetId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const source of incoming.get(id) ?? []) {
      if (keep.has(source)) continue;
      keep.add(source);
      queue.push(source);
    }
  }

  return {
    nodes: nodes.filter((node) => keep.has(node.id)),
    edges: edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}
