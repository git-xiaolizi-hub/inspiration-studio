/**
 * 工作流的持久化（IndexedDB）。
 *
 * **为什么单独开一个数据库，而不是往主库 `inspiration-assistant` 加一张表**：
 * 任务书的第一判据是"这个模块能整块删掉"。往主库加表要改 `src/core/storage/db.ts`，
 * 那行代码删掉工作流目录后仍然留在主库里 —— 变成了残迹；而 `mv src/ui/workflow` +
 * build 的判据也会因此变得需要"顺手清理别处"才成立。
 * 独立库的好处是：删目录 = 这个模块连同它的数据层一起消失，主库 schema 一个字节没动。
 *
 * 代价（报告里也写了）：工作流**不进现有备份包**（`core/backup` 的边界是 `STORE_NAMES`）。
 * 这是有意的取舍：备份扩容需要动 core，与解耦判据冲突。
 *
 * 另一个硬约定：**运行期状态不落库**。`status` / `error` / `warning` 一律在保存时剥掉，
 * 读回来全填 `idle` —— 否则刷新后会出现"上次跑到一半"的假"运行中"。
 */

import Dexie, { type Table } from 'dexie';
import type { WFEdge, WFNode, WFNodeData, Workflow } from './types';
import { isPackId, isWFNodeType } from './types';

export const WORKFLOW_DB_NAME = 'inspiration-assistant-workflows';
export const WORKFLOW_SCHEMA_VERSION = 1;

export type WorkflowRow = Workflow;

class WorkflowDatabase extends Dexie {
  workflows!: Table<WorkflowRow, string>;

  constructor(name: string = WORKFLOW_DB_NAME) {
    super(name);
    this.version(WORKFLOW_SCHEMA_VERSION).stores({ workflows: 'id, updatedAt' });
  }
}

let instance: WorkflowDatabase | null = null;

export function getWorkflowDatabase(): WorkflowDatabase {
  if (!instance) instance = new WorkflowDatabase();
  return instance;
}

/** 测试用：关连接并丢弃单例（下一次调用会重新打开） */
export function resetWorkflowDatabase(): void {
  if (!instance) return;
  try {
    instance.close();
  } finally {
    instance = null;
  }
}

/** 测试用：把库整个删掉（beforeEach 里避免用例互相污染） */
export async function deleteWorkflowDatabase(): Promise<void> {
  if (!instance) instance = new WorkflowDatabase();
  await instance.delete();
  instance = null;
}

function makeId(prefix: string): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  const suffix =
    globalCrypto && typeof globalCrypto.randomUUID === 'function'
      ? globalCrypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${suffix}`;
}

export function createWorkflowId(): string {
  return makeId('wf');
}

export function createNodeId(): string {
  return makeId('node');
}

export function createEdgeId(
  source: string,
  target: string,
  sourcePort?: string | null,
  targetPort?: string | null,
): string {
  // M5b2：同一对节点理论上可以在不同端口上各连一条，所以端口进 id
  const suffix = sourcePort || targetPort ? `_${sourcePort ?? '-'}_${targetPort ?? '-'}` : '';
  return `edge_${source}_${target}${suffix}`;
}

/** 只留持久化字段：status/error/warning 是运行期的，写进库就会变成"假运行中" */
export function persistentNodeData(data: WFNodeData): WFNodeData {
  const next: WFNodeData = {};
  if (typeof data.recordId === 'string' && data.recordId !== '') next.recordId = data.recordId;
  if (typeof data.text === 'string') next.text = data.text;
  if (typeof data.separator === 'string') next.separator = data.separator;
  if (data.labelParts === true) next.labelParts = true;
  if (isPackId(data.packId)) next.packId = data.packId;
  // M5b4：pack 节点指定的模型（"用哪个模型跑这个提示词包"是配置，不是运行期状态）
  if (typeof data.providerId === 'string' && data.providerId !== '') next.providerId = data.providerId;
  if (typeof data.customPromptId === 'string' && data.customPromptId !== '') {
    next.customPromptId = data.customPromptId;
  }
  // M5b4：图片源/视频源只存**引用**（artifacts / media 的主键），不把 base64 塞进工作流 JSON
  if (typeof data.sourceArtifactId === 'string' && data.sourceArtifactId !== '') {
    next.sourceArtifactId = data.sourceArtifactId;
  }
  if (typeof data.sourceMediaId === 'string' && data.sourceMediaId !== '') {
    next.sourceMediaId = data.sourceMediaId;
  }
  if (typeof data.fileName === 'string' && data.fileName !== '') next.fileName = data.fileName;
  if (typeof data.fileSize === 'number' && Number.isFinite(data.fileSize)) {
    next.fileSize = data.fileSize;
  }
  if (typeof data.vendorId === 'string') next.vendorId = data.vendorId;
  if (typeof data.modelId === 'string') next.modelId = data.modelId;
  if (data.promptFromUpstream === false) next.promptFromUpstream = false;
  if (data.resolution) next.resolution = data.resolution;
  if (typeof data.durationSec === 'number' && Number.isFinite(data.durationSec)) {
    next.durationSec = data.durationSec;
  }
  return next;
}

/** 深拷贝 + 剥运行期状态；存库与"另存为"都走它 */
export function serializeWorkflow(workflow: Workflow): Workflow {
  return {
    id: workflow.id,
    name: workflow.name,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      data: persistentNodeData(node.data),
    })),
    edges: workflow.edges.map((edge) => {
      const row: WFEdge = { id: edge.id, source: edge.source, target: edge.target };
      if (edge.sourceHandle) row.sourceHandle = edge.sourceHandle;
      if (edge.targetHandle) row.targetHandle = edge.targetHandle;
      return row;
    }),
  };
}

function normalizeNode(raw: unknown): WFNode | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const type = record.type;
  if (id === '' || !isWFNodeType(type)) return null;

  const position = record.position as { x?: unknown; y?: unknown } | undefined;
  const x = typeof position?.x === 'number' && Number.isFinite(position.x) ? position.x : 0;
  const y = typeof position?.y === 'number' && Number.isFinite(position.y) ? position.y : 0;
  const data = persistentNodeData(
    record.data !== null && typeof record.data === 'object'
      ? (record.data as WFNodeData)
      : {},
  );
  return { id, type, position: { x, y }, data };
}

function normalizeEdge(raw: unknown, nodeIds: Set<string>): WFEdge | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const source = typeof record.source === 'string' ? record.source : '';
  const target = typeof record.target === 'string' ? record.target : '';
  if (!nodeIds.has(source) || !nodeIds.has(target)) return null;
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : createEdgeId(source, target);
  const sourceHandle = typeof record.sourceHandle === 'string' && record.sourceHandle !== '' ? record.sourceHandle : null;
  const targetHandle = typeof record.targetHandle === 'string' && record.targetHandle !== '' ? record.targetHandle : null;
  return { id, source, target, sourceHandle, targetHandle };
}

/** 库里读出来的东西可能是手改过的 / 旧版本的：收敛成合法结构，坏节点直接丢 */
export function normalizeWorkflow(value: unknown): Workflow | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : '';
  if (id === '') return null;

  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map(normalizeNode).filter((node): node is WFNode => node !== null)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(record.edges)
    ? record.edges
        .map((edge) => normalizeEdge(edge, nodeIds))
        .filter((edge): edge is WFEdge => edge !== null)
    : [];

  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : Date.now();
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    ? record.updatedAt
    : createdAt;

  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() !== '' ? record.name : '未命名工作流',
    nodes,
    edges,
    createdAt,
    updatedAt,
  };
}

export async function saveWorkflow(workflow: Workflow): Promise<Workflow> {
  const row = serializeWorkflow(workflow);
  await getWorkflowDatabase().workflows.put(row);
  return row;
}

export async function loadWorkflow(id: string): Promise<Workflow | undefined> {
  const row = await getWorkflowDatabase().workflows.get(id);
  return row === undefined ? undefined : normalizeWorkflow(row) ?? undefined;
}

export async function listWorkflows(): Promise<Workflow[]> {
  const rows = await getWorkflowDatabase().workflows.orderBy('updatedAt').reverse().toArray();
  return rows
    .map((row) => normalizeWorkflow(row))
    .filter((row): row is Workflow => row !== null);
}

export async function removeWorkflow(id: string): Promise<void> {
  await getWorkflowDatabase().workflows.delete(id);
}
