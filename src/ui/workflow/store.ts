/**
 * 画布状态（zustand）。
 *
 * 为什么用 store 而不是把 nodes/edges 塞在页面 state 里：三个地方要读写同一份图
 * —— 画布（拖拽/连线）、节点面板（增删）、执行器（逐节点写状态）。
 * 用 store 才能让"执行器把 status 写进节点 data"这条在 React 之外也能生效
 * （`getState().updateNodeData(...)`），不必把回调闭包层层传下去。
 *
 * M5b2 的变化：
 * - `connect` 不再"顶掉旧边"，而是**校验后追加**（类型 / 一口一线，见 `graph.ts`）；
 * - 新增三种删除入口共用同一份"删除快照"，`Ctrl+Z` 只回滚删除（任务书 §3 的最小撤销）；
 * - 边带着端口名（handle id）走完 存库 → 读回 → 渲染 的整条链路。
 */

import { create } from 'zustand';
import { addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react';
import type { Connection, Edge, EdgeChange, Node, NodeChange, XYPosition } from '@xyflow/react';
import { createEdgeId, createNodeId, createWorkflowId, serializeWorkflow } from './db';
import { checkConnection } from './graph';
import type { SourceOption } from './sources';
import { instantiateTemplate } from './templates';
import type { WorkflowTemplate } from './templates';
import type { WFNodeData, WFNodeType, Workflow } from './types';
import { defaultNodeData } from './types';

/** xyflow 的 NodeData 必须满足 Record<string, unknown>；交叉类型既能索引又有字段提示 */
export type FlowNodeData = WFNodeData & Record<string, unknown>;

export type FlowNode = Node<FlowNodeData, WFNodeType>;

/** 边的渲染组件（自定义边：hover 出中点 ×，见 `WorkflowEdge.tsx`） */
export const WORKFLOW_EDGE_TYPE = 'workflow';

export interface WorkflowRecordOption {
  id: string;
  text: string;
  createdAt: number;
}

/** 模型下拉项（`key` = providerId::modelId，与创作页的选择器同形） */
export interface ModelOption {
  key: string;
  providerId: string;
  modelId: string;
  label: string;
  free?: boolean;
}
/** 删除快照：只记"被删掉的东西"，够 Ctrl+Z 用就行（不做完整撤销栈） */
interface DeletedSnapshot {
  nodes: FlowNode[];
  edges: Edge[];
}

export interface WorkflowStore {
  workflowId: string;
  name: string;
  createdAt: number;
  nodes: FlowNode[];
  edges: Edge[];
  /** 记录下拉的数据源（source 节点用） */
  records: WorkflowRecordOption[];
  /**
   * 模型下拉的数据源（image / video / pack 节点用）；由页面从 AI 配置加载后注入。
   * M5b4 加了 `text`：pack 节点现在可以指定"由哪个模型跑这个提示词包"。
   */
  models: { text: ModelOption[]; image: ModelOption[]; video: ModelOption[] };
  /**
   * 「当前默认文本模型」（M5b4 §2）：pack 节点没选模型时跟随它。
   * null = 一个文本模型都没配 → 节点上显示「未配置模型」并标黄。
   */
  textDefault: { providerId: string; modelId: string; label: string } | null;
  /** 「图片源 / 视频源」的候选（已有产物）；由页面加载后注入 */
  sources: { image: SourceOption[]; video: SourceOption[] };
  /** 上一次连线被拒的原因（页面横幅显示；null = 没有错） */
  connectError: string | null;
  /** 最近一次删除的快照（null = 没得撤销） */
  lastDeleted: DeletedSnapshot | null;
  /** 「提示词包」查看面板当前打开的节点 id */
  inspectorNodeId: string | null;

  setRecords: (records: WorkflowRecordOption[]) => void;
  setModels: (models: { text: ModelOption[]; image: ModelOption[]; video: ModelOption[] }) => void;
  setTextDefault: (model: { providerId: string; modelId: string; label: string } | null) => void;
  setSources: (sources: { image: SourceOption[]; video: SourceOption[] }) => void;
  /** 选中一个节点并打开它的检查器（执行日志点一下就定位过去） */
  focusNode: (id: string) => void;
  setName: (name: string) => void;
  clearConnectError: () => void;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  connect: (connection: Connection) => string | null;
  addNode: (type: WFNodeType, position?: XYPosition) => string;
  updateNodeData: (id: string, patch: Partial<WFNodeData>) => void;
  removeNode: (id: string) => void;
  removeNodes: (ids: readonly string[]) => void;
  removeEdge: (id: string) => void;
  /** 删掉画布上所有选中的节点与边（键盘 Delete / 右键菜单共用） */
  deleteSelection: () => number;
  clearCanvas: () => void;
  undoDelete: () => boolean;
  openInspector: (nodeId: string) => void;
  closeInspector: () => void;
  applyTemplate: (template: WorkflowTemplate) => void;
  setGraph: (nodes: FlowNode[], edges: Edge[]) => void;
  loadWorkflow: (workflow: Workflow) => void;
  reset: () => void;
  toWorkflow: (now?: () => number) => Workflow;
}

const EMPTY_NODES: FlowNode[] = [];
const EMPTY_EDGES: Edge[] = [];

const STATUS_RESET: Partial<WFNodeData> = { status: 'idle', error: undefined, warning: undefined };

/**
 * 新节点的落点：找一个不和已有节点重叠的空位。
 * M5b 按"第几个节点"算坐标，模板节点占了 (40,140) 这类位置时新节点会正好压上去
 * —— 用户会以为"点了没反应"。这里改成网格扫描 + 距离判定，找不到就用对角偏移兜底。
 */
function freeSpot(nodes: FlowNode[]): XYPosition {
  const taken = nodes.map((node) => node.position);
  for (let i = 0; i < 60; i += 1) {
    const x = 80 + (i % 5) * 260;
    const y = 80 + Math.floor(i / 5) * 200;
    const clash = taken.some((pos) => Math.abs(pos.x - x) < 200 && Math.abs(pos.y - y) < 120);
    if (!clash) return { x, y };
  }
  const step = nodes.length * 24;
  return { x: 80 + step, y: 80 + step };
}

export function toFlowNode(node: Workflow['nodes'][number]): FlowNode {
  return {
    id: node.id,
    type: node.type,
    position: { ...node.position },
    data: { ...node.data, ...STATUS_RESET },
  };
}

export function toFlowEdge(edge: Workflow['edges'][number]): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    type: WORKFLOW_EDGE_TYPE,
  };
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  workflowId: createWorkflowId(),
  name: '未命名工作流',
  createdAt: Date.now(),
  nodes: EMPTY_NODES,
  edges: EMPTY_EDGES,
  records: [],
  models: { text: [], image: [], video: [] },
  textDefault: null,
  sources: { image: [], video: [] },
  connectError: null,
  lastDeleted: null,
  inspectorNodeId: null,

  setRecords: (records) => set({ records }),
  setModels: (models) => set({ models }),
  setTextDefault: (textDefault) => set({ textDefault }),
  setSources: (sources) => set({ sources }),

  focusNode: (id) =>
    set((state) => ({
      nodes: state.nodes.map((node) => ({ ...node, selected: node.id === id })),
      inspectorNodeId: id,
      connectError: null,
    })),
  setName: (name) => set({ name }),
  clearConnectError: () => set({ connectError: null }),

  onNodesChange: (changes) =>
    set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),

  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),

  connect: (connection) => {
    const state = get();
    const verdict = checkConnection(
      state.nodes.map((node) => ({ id: node.id, type: node.type ?? 'source', data: node.data })),
      state.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      })),
      connection,
    );
    if (!verdict.ok) {
      set({ connectError: verdict.message });
      return verdict.message;
    }

    // 一对多：不清掉同源的旧边；一口一线由 checkConnection 保证
    const id = createEdgeId(
      connection.source,
      connection.target,
      connection.sourceHandle,
      connection.targetHandle,
    );
    set({
      connectError: null,
      edges: addEdge(
        {
          ...connection,
          id,
          type: WORKFLOW_EDGE_TYPE,
          sourceHandle: connection.sourceHandle ?? null,
          targetHandle: connection.targetHandle ?? null,
        },
        state.edges,
      ),
    });
    return null;
  },

  addNode: (type, position) => {
    const id = createNodeId();
    set((state) => ({
      nodes: [
        ...state.nodes,
        {
          id,
          type,
          position: position ?? freeSpot(state.nodes),
          data: { ...defaultNodeData(type), status: 'idle' },
        },
      ],
    }));
    return id;
  },

  updateNodeData: (id, patch) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, ...patch } } : node,
      ),
    })),

  removeNode: (id) => get().removeNodes([id]),

  removeNodes: (ids) => {
    const state = get();
    const doomed = new Set(ids);
    if (doomed.size === 0) return;
    const removedNodes = state.nodes.filter((node) => doomed.has(node.id));
    const removedEdges = state.edges.filter(
      (edge) => doomed.has(edge.source) || doomed.has(edge.target),
    );
    if (removedNodes.length === 0) return;
    set({
      nodes: state.nodes.filter((node) => !doomed.has(node.id)),
      // 删除节点连带删掉它的所有边（任务书 §3 的硬约束）
      edges: state.edges.filter((edge) => !doomed.has(edge.source) && !doomed.has(edge.target)),
      lastDeleted: { nodes: removedNodes, edges: removedEdges },
      inspectorNodeId:
        state.inspectorNodeId && doomed.has(state.inspectorNodeId) ? null : state.inspectorNodeId,
    });
  },

  removeEdge: (id) => {
    const state = get();
    const target = state.edges.find((edge) => edge.id === id);
    if (!target) return;
    set({
      edges: state.edges.filter((edge) => edge.id !== id),
      lastDeleted: { nodes: [], edges: [target] },
    });
  },

  deleteSelection: () => {
    const state = get();
    const nodeIds = new Set(state.nodes.filter((node) => node.selected === true).map((node) => node.id));
    const edgeIds = new Set(state.edges.filter((edge) => edge.selected === true).map((edge) => edge.id));
    if (nodeIds.size === 0 && edgeIds.size === 0) return 0;

    const removedNodes = state.nodes.filter((node) => nodeIds.has(node.id));
    const removedEdges = state.edges.filter(
      (edge) => edgeIds.has(edge.id) || nodeIds.has(edge.source) || nodeIds.has(edge.target),
    );

    set({
      nodes: state.nodes.filter((node) => !nodeIds.has(node.id)),
      edges: state.edges.filter(
        (edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target),
      ),
      lastDeleted: { nodes: removedNodes, edges: removedEdges },
      inspectorNodeId:
        state.inspectorNodeId && nodeIds.has(state.inspectorNodeId) ? null : state.inspectorNodeId,
    });
    return removedNodes.length + edgeIds.size;
  },

  clearCanvas: () => {
    const state = get();
    if (state.nodes.length === 0 && state.edges.length === 0) return;
    set({
      nodes: EMPTY_NODES,
      edges: EMPTY_EDGES,
      lastDeleted: { nodes: state.nodes, edges: state.edges },
      inspectorNodeId: null,
      connectError: null,
    });
  },

  undoDelete: () => {
    const snapshot = get().lastDeleted;
    if (!snapshot) return false;
    set((state) => {
      const nodeIds = new Set(state.nodes.map((node) => node.id));
      const edgeIds = new Set(state.edges.map((edge) => edge.id));
      return {
        nodes: [...state.nodes, ...snapshot.nodes.filter((node) => !nodeIds.has(node.id))],
        edges: [...state.edges, ...snapshot.edges.filter((edge) => !edgeIds.has(edge.id))],
        lastDeleted: null,
      };
    });
    return true;
  },

  openInspector: (nodeId) => set({ inspectorNodeId: nodeId }),
  closeInspector: () => set({ inspectorNodeId: null }),

  applyTemplate: (template) => {
    const { nodes, edges } = instantiateTemplate(template);
    set({
      workflowId: createWorkflowId(),
      name: template.title,
      createdAt: Date.now(),
      nodes: nodes.map(toFlowNode),
      edges: edges.map(toFlowEdge),
      lastDeleted: null,
      connectError: null,
      inspectorNodeId: null,
    });
  },

  setGraph: (nodes, edges) => set({ nodes, edges }),

  loadWorkflow: (workflow) =>
    set({
      workflowId: workflow.id,
      name: workflow.name,
      createdAt: workflow.createdAt,
      nodes: workflow.nodes.map(toFlowNode),
      edges: workflow.edges.map(toFlowEdge),
      lastDeleted: null,
      connectError: null,
      inspectorNodeId: null,
    }),

  reset: () =>
    set({
      workflowId: createWorkflowId(),
      name: '未命名工作流',
      createdAt: Date.now(),
      nodes: EMPTY_NODES,
      edges: EMPTY_EDGES,
      lastDeleted: null,
      connectError: null,
      inspectorNodeId: null,
    }),

  toWorkflow: (now = Date.now) => {
    const state = get();
    const stamp = now();
    return serializeWorkflow({
      id: state.workflowId,
      name: state.name,
      createdAt: state.createdAt,
      updatedAt: stamp,
      nodes: state.nodes.map((node) => ({
        id: node.id,
        type: node.type ?? 'source',
        position: { x: node.position.x, y: node.position.y },
        data: node.data,
      })),
      edges: state.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      })),
    });
  },
}));
