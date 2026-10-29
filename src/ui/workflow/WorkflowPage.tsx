/**
 * 工作向画板页面（M5b2；M5b4：中间产物可审核 / 可指定模型 / 图片与视频源）。
 *
 * 这一层只做"编排"：加载配置 → 把图交给执行器 → 把状态写回节点 → 弹费用确认。
 * 真正的请求都在 `WorkflowRuntime.ts`（装配既有适配器）与 `executor.ts`（顺序/失败传播）。
 *
 * 与任务书对齐的硬语义：
 * 1. **DAG**：连线按端口类型校验（`store.connect` → `graph.checkConnection`），
 *    一个输出可以接多个下游；同一个输入口最多一条线；
 * 2. **成本闸门**：image/video 节点执行前必须点确认；拒绝 = 零请求（执行器保证）；
 * 3. **停止**：只丢弃结果，不假装能取消服务端（视频节点额外提示）；
 * 4. **删除的三条路径**：键盘（Delete/Backspace）、节点/边上的 hover ×、右键菜单；
 *    删完可以 `Ctrl+Z` 回来（只回滚删除，不做完整撤销栈）；
 * 5. **M5b4 每步确认**：逐个节点暂停、展开结果、`[继续] [重跑此步] [中止]`
 *    —— 顺序执行与"单节点单次"不变，`retry` 只重跑当前节点（且再过一次成本闸门）；
 * 6. **M5b4 运行到此节点**：把图裁成目标节点的祖先链（`graph.subgraphTo`），执行器一行不改。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { activeConnectionFor, loadCatalog, multiplierOf } from '../../adapters/ai-models/catalog';
import type { AICatalog } from '../../adapters/ai-models/catalog';
import { loadPriceTable } from '../../adapters/ai-models/config-store';
import { OFFICIAL_PRICE_TABLE } from '../../adapters/ai-models/pricing';
import type { PriceTable } from '../../adapters/ai-models/pricing';
import { listRecords } from '../../core/records';
import {
  cachedCustomPromptFor,
  hydrateCustomPrompts,
  removeCustomPrompt,
  restoreBuiltinPrompt,
  saveCustomPromptForPack,
  validateCustomPromptDraft,
} from '../../core/custom-prompts';
import type { Workflow as WorkflowRecord, WFNodeType } from './types';
import { NODE_TYPE_LABELS, PACK_LABELS, isPackId } from './types';
import type { PackId } from './types';
import { executeWorkflow } from './executor';
import type { CostQuote, NodeDoneVerdict, NodeOutput } from './executor';
import { describeGraphError, subgraphTo, validateWorkflowGraph } from './graph';
import { costConfirmText, quoteForNode } from './cost';
import { createNodeHandlers } from './WorkflowRuntime';
import { defaultTextModelRef, modelOptionsFor } from './models';
import { listWorkflows, loadWorkflow, saveWorkflow } from './db';
import { packInspectorParts, packOutputFields, packSystemPrompt } from './packs';
import { listSourceOptions } from './sources';

import { useWorkflowStore } from './store';
import type { FlowNode } from './store';
import { WORKFLOW_TEMPLATES } from './templates';
import type { WorkflowTemplate } from './templates';
import { workflowNodeTypes } from './WorkflowNodes';
import { workflowEdgeTypes } from './WorkflowEdge';
import { EnsureNodesMeasured } from './canvas-measure';
import './workflow.css';

/** 左栏顺序：文本类 → 素材类 → 生成类 → 出口 */
const PALETTE: WFNodeType[] = [
  'source',
  'imageSource',
  'videoSource',
  'merge',
  'pack',
  'image',
  'video',
  'output',
];

const EMPTY_CATALOG: AICatalog = { providers: [], updatedAt: 0 };

/** 执行模式的记忆位置（"记住上次选择"就是这一条） */
export const EXEC_MODE_STORAGE_KEY = 'ia-v2.wf.execMode';
/** 「正在运行」的标记：刷新时还留着 → 说明上次被中断了（不能显示成"运行中"） */
export const RUN_MARK_STORAGE_KEY = 'ia-v2.wf.running';

export type ExecMode = 'auto' | 'step';

export function readExecMode(): ExecMode {
  try {
    const raw = globalThis.localStorage?.getItem(EXEC_MODE_STORAGE_KEY);
    return raw === 'step' ? 'step' : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeExecMode(mode: ExecMode): void {
  try {
    globalThis.localStorage?.setItem(EXEC_MODE_STORAGE_KEY, mode);
  } catch {
    /* 隐私模式：记不住就算了，不阻断运行 */
  }
}

export function markRunStarted(workflowId: string): void {
  try {
    globalThis.localStorage?.setItem(
      RUN_MARK_STORAGE_KEY,
      JSON.stringify({ workflowId, at: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

export function clearRunMark(): void {
  try {
    globalThis.localStorage?.removeItem(RUN_MARK_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 刷新后的第一句话（§3.2 最后一条）：**不能显示成"正在运行"**。
 * 返回 null = 上次是正常结束的；返回字符串 = 上次被中断，要点运行重跑。
 */
export function consumeInterruptedRun(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(RUN_MARK_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    globalThis.localStorage?.removeItem(RUN_MARK_STORAGE_KEY);
    return '上次执行被中断（刷新时正在运行或等待确认）：节点已恢复为「未运行」，重新点运行即可';
  } catch {
    return null;
  }
}

interface LoadedConfig {
  catalog: AICatalog;
  priceTable: PriceTable;
}

interface ContextMenuState {
  x: number;
  y: number;
  kind: 'node' | 'edge' | 'pane';
  id?: string;
}

/** 执行日志的一行（§3.1）：点它可以定位到节点 */
interface RunLogEntry {
  nodeId: string;
  status: string;
  startedAt: number;
  ms?: number;
}

const STATUS_ICON: Record<string, string> = {
  running: '●',
  ok: '✅',
  error: '✗',
  skipped: '⏭',
  idle: '○',
};

function toExecNodes(nodes: FlowNode[]): Array<{ id: string; type: string; data: FlowNode['data'] }> {
  return nodes.map((node) => ({ id: node.id, type: node.type ?? 'source', data: node.data }));
}

function toExecEdges(
  edges: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>,
): Array<{ source: string; target: string; sourceHandle: string | null; targetHandle: string | null }> {
  return edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }));
}

export function WorkflowPage() {
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const name = useWorkflowStore((state) => state.name);
  const setName = useWorkflowStore((state) => state.setName);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const onEdgesChange = useWorkflowStore((state) => state.onEdgesChange);
  const connect = useWorkflowStore((state) => state.connect);
  const connectError = useWorkflowStore((state) => state.connectError);
  const inspectorNodeId = useWorkflowStore((state) => state.inspectorNodeId);
  const lastDeleted = useWorkflowStore((state) => state.lastDeleted);

  const [loaded, setLoaded] = useState<LoadedConfig>({
    catalog: EMPTY_CATALOG,
    priceTable: OFFICIAL_PRICE_TABLE,
  });
  const [saved, setSaved] = useState<WorkflowRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState('');
  const [pendingQuote, setPendingQuote] = useState<CostQuote | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  /* ---- M5b4：执行模式 / 执行日志 / 每步确认 ---- */
  const [execMode, setExecMode] = useState<ExecMode>(() => readExecMode());
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [pendingStep, setPendingStep] = useState<{ nodeId: string; output: NodeOutput } | null>(null);

  /* ---- 自定义提示词副本（只在这个查看面板里编辑） ---- */
  /** 副本改动计数器：快照是模块级的，改完靠它触发重算 */
  const [customRev, setCustomRev] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const runSeq = useRef(0);
  const stopRequested = useRef(false);
  const confirmResolver = useRef<((approved: boolean) => void) | null>(null);
  const stepResolver = useRef<((verdict: NodeDoneVerdict) => void) | null>(null);

  /* ---------------------------------------------------------------- */
  /* 初始化：AI 配置 / 记录 / 素材候选 / 上次保存的工作流                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [catalog, priceTable, recordsPage, workflows] = await Promise.all([
        loadCatalog(),
        loadPriceTable(),
        listRecords({ pageSize: 30 }),
        listWorkflows(),
      ]);
      // 副本快照：读进内存后 `loadPackForWorkflow` / `loadBrowserPack` 才能同步解析到它
      await hydrateCustomPrompts();

      // 图片源 / 视频源的候选（读 IndexedDB；失败不该让整页挂掉）
      let images = [] as Awaited<ReturnType<typeof listSourceOptions>>;
      let videos = [] as Awaited<ReturnType<typeof listSourceOptions>>;
      try {
        [images, videos] = await Promise.all([
          listSourceOptions('image'),
          listSourceOptions('video'),
        ]);
      } catch {
        /* 库打不开：下拉空着，用户还能上传 */
      }

      if (cancelled) return;
      setCustomRev((value) => value + 1);

      setLoaded({ catalog, priceTable });
      useWorkflowStore.getState().setModels({
        text: modelOptionsFor(catalog, 'text'),
        image: modelOptionsFor(catalog, 'image'),
        video: modelOptionsFor(catalog, 'video'),
      });
      useWorkflowStore.getState().setTextDefault(defaultTextModelRef(catalog));
      useWorkflowStore.getState().setSources({ image: images, video: videos });
      useWorkflowStore.getState().setRecords(
        recordsPage.items.map((item) => ({
          id: item.id,
          text: item.text,
          createdAt: item.createdAt,
        })),
      );
      setSaved(workflows);
      // 刷新后自动回到最近一次保存的画布（"坐标与连线还在"靠这条）
      if (workflows.length > 0 && useWorkflowStore.getState().nodes.length === 0) {
        useWorkflowStore.getState().loadWorkflow(workflows[0]);
      }
    };
    void load();

    // §3.2：「暂停中刷新页面」不能显示成正在运行 —— 节点一律回 idle（toFlowNode 已保证），
    // 这里再给一句人话，告诉用户"上次那次没跑完"。
    const interrupted = consumeInterruptedRun();
    if (interrupted !== null) setStatusLine(interrupted);

    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* 键盘：Delete/Backspace 删除选中；Ctrl+Z 撤销删除                    */
  /* （xyflow 的 deleteKeyCode 置 null，否则它会绕过删除快照直接删）      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        const restored = useWorkflowStore.getState().undoDelete();
        if (restored) {
          event.preventDefault();
          setStatusLine('已撤销上一次删除');
        }
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        const removed = useWorkflowStore.getState().deleteSelection();
        if (removed > 0) {
          event.preventDefault();
          setStatusLine(`已删除 ${removed} 个元素（Ctrl+Z 可撤销）`);
        }
        return;
      }

      if (event.key === 'Escape') {
        setContextMenu(null);
        setShowTemplates(false);
        setConfirmClear(false);
        useWorkflowStore.getState().closeInspector();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /* ---------------------------------------------------------------- */
  /* 运行 / 停止 / 每步确认                                            */
  /* ---------------------------------------------------------------- */

  const askConfirm = useCallback(
    (quote: CostQuote) =>
      new Promise<boolean>((resolve) => {
        confirmResolver.current = resolve;
        setPendingQuote(quote);
      }),
    [],
  );

  const answerConfirm = useCallback((approved: boolean) => {
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setPendingQuote(null);
    resolve?.(approved);
  }, []);

  /** §3.2：问"这一步之后怎么办"。只有"每步确认"模式才会被调用。 */
  const askStep = useCallback(
    (nodeId: string, output: NodeOutput) =>
      new Promise<NodeDoneVerdict>((resolve) => {
        stepResolver.current = resolve;
        setPendingStep({ nodeId, output });
      }),
    [],
  );

  const answerStep = useCallback((verdict: NodeDoneVerdict) => {
    const resolve = stepResolver.current;
    stepResolver.current = null;
    setPendingStep(null);
    resolve?.(verdict);
  }, []);

  const resetRunMarks = (scope?: Set<string> | null) => {
    const store = useWorkflowStore.getState();
    for (const node of store.nodes) {
      if (scope && !scope.has(node.id)) continue;
      store.updateNodeData(node.id, {
        status: 'idle',
        error: undefined,
        warning: undefined,
        resultText: undefined,
        mediaUrl: undefined,
        mediaKind: undefined,
        artifactId: undefined,
      });
    }
  };

  const stop = useCallback(() => {
    stopRequested.current = true;
    // 正在等费用确认：直接按"取消"处理，否则执行器会卡在那个 Promise 上
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setPendingQuote(null);
    resolve?.(false);
    // 正在等"每步确认"：按中止处理（等价于停止）
    const step = stepResolver.current;
    stepResolver.current = null;
    setPendingStep(null);
    step?.('abort');
    setStatusLine('正在停止：未开始的节点会标为「已跳过」，在途请求的结果会被丢弃');
  }, []);

  /**
   * 跑一次。
   * `targetId` 有值 = 「运行到此节点」：先把图裁成它的祖先链（§3.3）。
   */
  const run = async (targetId?: string) => {
    const store = useWorkflowStore.getState();
    let execNodes = toExecNodes(store.nodes);
    let execEdges = toExecEdges(store.edges);

    let scope: Set<string> | null = null;
    if (targetId) {
      try {
        const sub = subgraphTo(targetId, execNodes, execEdges);
        execNodes = toExecNodes(sub.nodes as FlowNode[]);
        execEdges = toExecEdges(sub.edges as Array<{ source: string; target: string }>);
        scope = new Set(execNodes.map((node) => node.id));
      } catch (caught) {
        setError(describeGraphError(caught));
        return;
      }
    }

    // 预校验：错误直接显示在页面上（执行器内部还会再校验一次，这里是给人看的即时反馈）
    try {
      validateWorkflowGraph(execNodes, execEdges);
    } catch (caught) {
      setError(describeGraphError(caught));
      return;
    }

    // 上一轮还在等确认：先把它按中止收掉，避免两个 Promise 打架
    if (stepResolver.current) answerStep('abort');

    setError(null);
    setStatusLine(
      targetId
        ? `运行到「${NODE_TYPE_LABELS[store.nodes.find((n) => n.id === targetId)?.type ?? 'source']}」为止…`
        : '运行中…',
    );
    resetRunMarks(scope);
    setRunLog([]);
    stopRequested.current = false;
    const runId = runSeq.current + 1;
    runSeq.current = runId;
    setRunning(true);
    markRunStarted(store.workflowId);

    const sourceRecordId = store.nodes.find((node) => node.type === 'source')?.data.recordId;
    const handlers = createNodeHandlers({
      catalog: loaded.catalog,
      priceTable: loaded.priceTable,
      workflowId: store.workflowId,
      recordId: sourceRecordId,
    });

    const multiplierFor = (vendorId?: string): number =>
      multiplierOf(activeConnectionFor(loaded.catalog, vendorId ?? ''));

    /** 执行日志：running 时开一条，终态时补时长（UI 只读，不参与执行语义） */
    const logStatus = (nodeId: string, status: string) => {
      setRunLog((prev) => {
        const index = prev.findIndex((entry) => entry.nodeId === nodeId);
        if (status === 'running') {
          const entry: RunLogEntry = { nodeId, status, startedAt: Date.now() };
          if (index === -1) return [...prev, entry];
          const next = [...prev];
          next[index] = entry;
          return next;
        }
        if (index === -1) {
          return [...prev, { nodeId, status, startedAt: Date.now(), ms: 0 }];
        }
        const next = [...prev];
        next[index] = {
          ...next[index],
          status,
          ms: Math.max(0, Date.now() - next[index].startedAt),
        };
        return next;
      });
    };

    try {
      const result = await executeWorkflow(execNodes, execEdges, {
        ...handlers,
        // 三家的官方生图接口都没有参考图字段（M5a2 的契约）；接上参考图口会被忽略并提示
        imageReferenceSupported: false,
        quote: (node) =>
          quoteForNode(node, {
            priceTable: loaded.priceTable,
            multiplier: multiplierFor(node.data.vendorId),
          }),
        confirm: askConfirm,
        onStatus: (nodeId, patch) => {
          useWorkflowStore.getState().updateNodeData(nodeId, patch);
          if (patch.status) logStatus(nodeId, patch.status);
        },
        // §3.1：每个节点跑完就把自己的结果挂到节点上（摘要 / 缩略图 / 首帧）
        onOutput: (nodeId, output) =>
          useWorkflowStore.getState().updateNodeData(nodeId, {
            resultText: output.text,
            mediaUrl: output.media?.url,
            mediaKind: output.media?.kind,
            artifactId: output.media?.artifactId,
          }),
        // §3.2：只有"每步确认"模式才逐节点暂停（不传 = 自动跑完，与 M5b3 一致）
        onNodeDone: execMode === 'step' ? askStep : undefined,
        isStopped: () => stopRequested.current,
      });

      if (runSeq.current !== runId) return;

      const problem = Object.values(result.states).some((state) => state.status === 'error');
      setStatusLine(
        result.aborted
          ? '已中止（这一步之后都没有跑）'
          : result.stopped
            ? '已停止（未开始的节点标为「已跳过」）'
            : problem
              ? '运行结束：有节点失败，后面的节点已跳过'
              : `运行完成：${result.order.length} 个节点全部成功`,
      );
    } catch (caught) {
      setError(describeGraphError(caught));
      setStatusLine('');
    } finally {
      clearRunMark();
      if (runSeq.current === runId) setRunning(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /* 保存 / 载入 / 新建 / 模板                                          */
  /* ---------------------------------------------------------------- */

  const refreshSaved = async () => {
    setSaved(await listWorkflows());
  };

  const save = async () => {
    try {
      const store = useWorkflowStore.getState();
      const workflow = store.toWorkflow();
      if (workflow.nodes.length === 0) {
        setError('画布是空的：先放几个节点再保存');
        return;
      }
      // 保存后把 id 固定下来（首次保存前 id 是随机的临时值）
      useWorkflowStore.setState({ workflowId: workflow.id, createdAt: workflow.createdAt });
      await saveWorkflow(workflow);
      await refreshSaved();
      setError(null);
      setStatusLine(`已保存「${workflow.name}」：${workflow.nodes.length} 个节点、${workflow.edges.length} 条连线`);
    } catch (caught) {
      setError(describeGraphError(caught));
    }
  };

  const openSaved = async (id: string) => {
    if (id === '') return;
    const workflow = await loadWorkflow(id);
    if (!workflow) {
      setError('这个工作流找不到了（可能已被删除）');
      return;
    }
    useWorkflowStore.getState().loadWorkflow(workflow);
    setStatusLine(`已打开「${workflow.name}」`);
  };

  const interruptRun = () => {
    stopRequested.current = true;
    if (stepResolver.current) answerStep('abort');
  };

  const createNew = () => {
    interruptRun();
    useWorkflowStore.getState().reset();
    setRunLog([]);
    setStatusLine('新建了一块空画布：可以直接从下面三个模板开始');
    setError(null);
  };

  const applyTemplate = (template: WorkflowTemplate) => {
    interruptRun();
    useWorkflowStore.getState().applyTemplate(template);
    setShowTemplates(false);
    setRunLog([]);
    setError(null);
    setStatusLine(`已载入模板「${template.title}」：点「运行」试试`);
  };

  const addNode = (type: WFNodeType) => {
    useWorkflowStore.getState().addNode(type);
  };

  /* ---------------------------------------------------------------- */
  /* 检查器（每个节点都能看完整结果；「提示词包」额外有提示词与副本编辑）  */
  /* ---------------------------------------------------------------- */

  const inspector = useMemo(() => {
    if (!inspectorNodeId) return null;
    const node = nodes.find((item) => item.id === inspectorNodeId);
    if (!node) return null;
    const type = node.type ?? 'source';
    const packId: PackId | null =
      type === 'pack' ? (isPackId(node.data.packId) ? node.data.packId : 'dream-interpretation') : null;
    return {
      nodeId: node.id,
      type,
      label: packId ? PACK_LABELS[packId] : NODE_TYPE_LABELS[type],
      packId,
      /** 生效中的全文：有副本就是「副本正文 + 内置校验清单 + 内置硬禁止」 */
      systemPrompt: packId ? packSystemPrompt(packId) : '',
      fields: packId ? packOutputFields(packId) : [],
      parts: packId ? packInspectorParts(packId) : null,
      custom: packId ? cachedCustomPromptFor(packId) : null,
      /* ---- 这一步的结果（§3.1：完整输出） ---- */
      outputText: node.data.resultText ?? '',
      mediaUrl: node.data.mediaUrl ?? '',
      mediaKind: node.data.mediaKind,
      status: node.data.status ?? 'idle',
      warning: node.data.warning,
      nodeError: node.data.error,
    };
    // customRev：副本存/删/还原后强制重算（快照在模块里，不是 React state）
  }, [inspectorNodeId, nodes, customRev]);

  /* 换节点 / 关面板 → 退出编辑态（避免把 A 的草稿存到 B 上） */
  const openNodeId = inspector?.nodeId ?? null;
  useEffect(() => {
    setEditing(false);
    setFormError(null);
    setConfirmRemove(false);
  }, [openNodeId]);

  /** 角标同步：同一个 pack 的所有「提示词包」节点都按同一份副本生效 */
  const syncCustomBadge = (packId: PackId, customPromptId?: string) => {
    const store = useWorkflowStore.getState();
    for (const node of store.nodes) {
      if (node.type !== 'pack') continue;
      const nodePackId = isPackId(node.data.packId) ? node.data.packId : 'dream-interpretation';
      if (nodePackId !== packId) continue;
      store.updateNodeData(node.id, { customPromptId });
    }
  };

  const startEditing = () => {
    if (!inspector || !inspector.parts) return;
    setDraftName(inspector.custom?.name ?? `${inspector.label} 的副本`);
    setDraftBody(inspector.custom?.body ?? inspector.parts.builtinBody);
    setFormError(null);
    setConfirmRemove(false);
    setEditing(true);
  };

  const cancelEditing = () => {
    if (!inspector) return;
    setDraftName(inspector.custom?.name ?? '');
    setDraftBody('');
    setFormError(null);
    setConfirmRemove(false);
    setEditing(false);
  };

  const saveDraft = async () => {
    if (!inspector || !inspector.packId) return;
    // 先本地校验：不合格只红字提示，一个字节都不写库
    const problem = validateCustomPromptDraft({ name: draftName, body: draftBody });
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    try {
      const savedPrompt = await saveCustomPromptForPack(inspector.packId, {
        name: draftName,
        body: draftBody,
      });
      syncCustomBadge(inspector.packId, savedPrompt.id);
      setCustomRev((value) => value + 1);
      setFormError(null);
      setEditing(false);
      setStatusLine(
        `已保存副本「${savedPrompt.name}」：之后跑这个提示词包会用你的正文（校验清单与硬禁止不变）`,
      );
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const restoreBuiltin = async () => {
    if (!inspector || !inspector.packId) return;
    setSaving(true);
    try {
      const removed = await restoreBuiltinPrompt(inspector.packId);
      syncCustomBadge(inspector.packId, undefined);
      setCustomRev((value) => value + 1);
      setEditing(false);
      setFormError(null);
      setConfirmRemove(false);
      setStatusLine(removed > 0 ? '已还原为内置提示词' : '现在用的就是内置提示词');
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const deleteCustom = async () => {
    if (!inspector?.custom || !inspector.packId) return;
    setSaving(true);
    try {
      await removeCustomPrompt(inspector.custom.id);
      syncCustomBadge(inspector.packId, undefined);
      setCustomRev((value) => value + 1);
      setConfirmRemove(false);
      setEditing(false);
      setFormError(null);
      setStatusLine('副本已删除：这个提示词包回到内置正文');
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const copyPrompt = async () => {
    if (!inspector) return;
    try {
      await navigator.clipboard.writeText(inspector.systemPrompt);
      setStatusLine('提示词已复制到剪贴板');
    } catch {
      setStatusLine('浏览器不给剪贴板权限：全选下面的文本框手动复制');
    }
  };

  const copyOutput = async () => {
    if (!inspector) return;
    try {
      await navigator.clipboard.writeText(inspector.outputText);
      setStatusLine('这一步的结果已复制到剪贴板');
    } catch {
      setStatusLine('浏览器不给剪贴板权限：全选文本手动复制');
    }
  };

  const nodeTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of nodes) counts[node.type ?? 'source'] = (counts[node.type ?? 'source'] ?? 0) + 1;
    return counts;
  }, [nodes]);

  /** 只关心"有哪几个节点"，给补测用（M5b3） */
  const nodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);

  /** 当前选中的单个节点（右键菜单 / 「运行到此节点」的入口条件） */
  const selectedNode = useMemo(() => {
    const picked = nodes.filter((node) => node.selected === true);
    return picked.length === 1 ? picked[0] : null;
  }, [nodes]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const empty = nodes.length === 0;

  const labelOf = (nodeId: string): string => {
    const node = nodeById.get(nodeId);
    if (!node) return '节点';
    const type = node.type ?? 'source';
    if (type === 'pack') {
      const packId = isPackId(node.data.packId) ? node.data.packId : 'dream-interpretation';
      return `${NODE_TYPE_LABELS.pack}（${PACK_LABELS[packId]}）`;
    }
    return NODE_TYPE_LABELS[type];
  };

  return (
    <div className="wf-page">
      <header className="wf-toolbar">
        <input
          className="wf-name"
          value={name}
          aria-label="工作流名称"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" onClick={() => void save()}>
          保存
        </button>
        <button type="button" onClick={createNew}>
          新建
        </button>
        <select
          aria-label="打开已保存的工作流"
          className="wf-select wf-open"
          value=""
          onChange={(event) => void openSaved(event.target.value)}
        >
          <option value="">打开…（{saved.length}）</option>
          {saved.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setShowTemplates(true)}>
          模板…
        </button>
        <button
          type="button"
          onClick={() => {
            if (useWorkflowStore.getState().undoDelete()) setStatusLine('已撤销上一次删除');
          }}
          disabled={!lastDeleted}
          title="撤销上一次删除（Ctrl+Z）"
        >
          撤销删除
        </button>

        {/* M5b4 §3.2：执行模式（记住上次选择） */}
        <select
          className="wf-select wf-mode"
          aria-label="执行模式"
          data-testid="wf-exec-mode"
          value={execMode}
          onChange={(event) => {
            const next: ExecMode = event.target.value === 'step' ? 'step' : 'auto';
            setExecMode(next);
            writeExecMode(next);
          }}
        >
          <option value="auto">自动跑完</option>
          <option value="step">每步确认</option>
        </select>

        <span className="wf-spacer" />
        {/* M5b4 §3.3：只跑到选中的那个节点（上游链路） */}
        <button
          type="button"
          data-testid="wf-run-to"
          onClick={() => {
            if (selectedNode) void run(selectedNode.id);
          }}
          disabled={running || !selectedNode}
          title="只运行到选中的这个节点（它的上游链路），兄弟分支不动"
        >
          运行到此节点
        </button>
        <button type="button" className="wf-primary" onClick={() => void run()} disabled={running}>
          {running ? '运行中…' : '运行'}
        </button>
        <button type="button" onClick={stop} disabled={!running}>
          停止
        </button>
      </header>

      {error && <p className="wf-banner wf-banner-error" role="alert">{error}</p>}
      {!error && connectError && (
        <p className="wf-banner wf-banner-error" role="alert">{connectError}</p>
      )}
      {!error && !connectError && statusLine && (
        <p className="wf-banner" role="status">{statusLine}</p>
      )}

      {/* M5b4 §3.1：执行日志（点一条就定位到那个节点） */}
      {runLog.length > 0 && (
        <div className="wf-runlog" data-testid="wf-runlog" aria-label="执行日志">
          {runLog.map((entry, index) => {
            const paused = pendingStep?.nodeId === entry.nodeId;
            const status = paused ? 'paused' : entry.status;
            return (
              <button
                key={entry.nodeId}
                type="button"
                className="wf-runlog-item"
                data-testid="wf-runlog-item"
                data-status={status}
                data-log-node={entry.nodeId}
                onClick={() => useWorkflowStore.getState().focusNode(entry.nodeId)}
                title="点一下定位到这个节点"
              >
                <span className="wf-runlog-index">{index + 1}</span>
                <span className="wf-runlog-label">{labelOf(entry.nodeId)}</span>
                <span className="wf-runlog-icon">
                  {paused ? '⏸ 等待确认' : (STATUS_ICON[entry.status] ?? entry.status)}
                </span>
                {entry.ms !== undefined && !paused && (
                  <span className="wf-runlog-ms">{(entry.ms / 1000).toFixed(1)}s</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="wf-body">
        <aside className="wf-palette">
          <p className="wf-palette-title">加节点</p>
          {PALETTE.map((type) => (
            <button key={type} type="button" className="wf-palette-item" onClick={() => addNode(type)}>
              + {NODE_TYPE_LABELS[type]}
              {nodeTypeCounts[type] ? `（${nodeTypeCounts[type]}）` : ''}
            </button>
          ))}
          <p className="wf-hint">
            一个输出可以接多个下游；同一个输入口只接一条线，要合并文本请加「文本合并」。
            每个节点只跑一次，需要对话请去创作页。
          </p>
          <p className="wf-hint">
            删除：选中后按 Delete / 点节点右上角 × / 点连线中点的 × / 右键菜单；Ctrl+Z 撤销删除。
          </p>
          <p className="wf-hint">
            点节点看这一步的完整结果；「每步确认」会在每个节点跑完后停下来等你。
          </p>
        </aside>

        <div className="wf-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={workflowNodeTypes}
            edgeTypes={workflowEdgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(connection) => connect(connection)}
            onNodeClick={(_event, node) => {
              // 跑过的节点：点一下就看它的完整结果（没有结果时只选中，不弹抽屉）
              const data = useWorkflowStore.getState().nodes.find((item) => item.id === node.id)?.data;
              if (data && (data.resultText || data.mediaUrl)) {
                useWorkflowStore.getState().openInspector(node.id);
              }
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setContextMenu({ x: event.clientX, y: event.clientY, kind: 'node', id: node.id });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              setContextMenu({ x: event.clientX, y: event.clientY, kind: 'edge', id: edge.id });
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ x: event.clientX, y: event.clientY, kind: 'pane' });
            }}
            onPaneClick={() => setContextMenu(null)}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.4}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>

          {/* M5b3：补测节点尺寸（页面不出帧时 ResizeObserver 不投递，边会静默不渲染） */}
          <EnsureNodesMeasured ids={nodeIds} />

          {empty && (
            <div className="wf-empty" data-testid="wf-empty-templates">
              <p className="wf-empty-title">从哪儿开始？</p>
              <p className="wf-empty-sub">
                选一个模板直接改，或者从左边的「加节点」自己搭（模板只是起点，随时可改）。
              </p>
              <div className="wf-template-cards">
                {WORKFLOW_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="wf-template-card"
                    data-template={template.id}
                    onClick={() => applyTemplate(template)}
                  >
                    <span className="wf-template-title">{template.title}</span>
                    <span className="wf-template-desc">{template.description}</span>
                    <span className="wf-template-note">{template.note}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <>
          <div className="wf-menu-backdrop" onClick={() => setContextMenu(null)} />
          <div
            className="wf-menu"
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
            role="menu"
          >
            {contextMenu.kind === 'node' && (
              <button
                type="button"
                role="menuitem"
                data-testid="wf-menu-run-to"
                onClick={() => {
                  const id = contextMenu.id;
                  setContextMenu(null);
                  if (id) void run(id);
                }}
              >
                运行到此节点（只跑它的上游）
              </button>
            )}
            {contextMenu.kind === 'node' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (contextMenu.id) useWorkflowStore.getState().removeNodes([contextMenu.id]);
                  setContextMenu(null);
                  setStatusLine('已删除节点（Ctrl+Z 可撤销）');
                }}
              >
                删除节点
              </button>
            )}
            {contextMenu.kind === 'edge' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (contextMenu.id) useWorkflowStore.getState().removeEdge(contextMenu.id);
                  setContextMenu(null);
                  setStatusLine('已删除连线（Ctrl+Z 可撤销）');
                }}
              >
                删除连线
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                setConfirmClear(true);
              }}
            >
              清空画布…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                setShowTemplates(true);
              }}
            >
              打开模板…
            </button>
          </div>
        </>
      )}

      {showTemplates && (
        <div className="wf-modal-backdrop" role="dialog" aria-modal="true" aria-label="选择模板">
          <div className="wf-modal wf-modal-wide">
            <p className="wf-modal-title">从模板开始</p>
            <p className="wf-modal-sub">载入会替换当前画布（没保存的改动会丢）。</p>
            <div className="wf-template-cards">
              {WORKFLOW_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="wf-template-card"
                  data-template={template.id}
                  onClick={() => applyTemplate(template)}
                >
                  <span className="wf-template-title">{template.title}</span>
                  <span className="wf-template-desc">{template.description}</span>
                  <span className="wf-template-note">{template.note}</span>
                </button>
              ))}
            </div>
            <div className="wf-modal-actions">
              <button type="button" onClick={() => setShowTemplates(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmClear && (
        <div className="wf-modal-backdrop" role="dialog" aria-modal="true" aria-label="清空画布">
          <div className="wf-modal">
            <p className="wf-modal-title">清空整块画布？</p>
            <p className="wf-modal-sub">
              会删掉 {nodes.length} 个节点、{edges.length} 条连线。没保存的改动会丢（Ctrl+Z 只能撤销一次）。
            </p>
            <div className="wf-modal-actions">
              <button type="button" onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button
                type="button"
                className="wf-primary"
                onClick={() => {
                  useWorkflowStore.getState().clearCanvas();
                  setConfirmClear(false);
                  setStatusLine('画布已清空（Ctrl+Z 可撤销一次）');
                }}
              >
                确认清空
              </button>
            </div>
          </div>
        </div>
      )}

      {/* §3.2：每一节点跑完后的三个人工动作 */}
      {pendingStep && (
        <div
          className="wf-step"
          role="dialog"
          aria-modal="true"
          aria-label="每步确认"
          data-testid="wf-step"
        >
          <p className="wf-step-title">
            这一步跑完了：{labelOf(pendingStep.nodeId)} —— 继续下一步？
          </p>
          <div className="wf-step-preview">
            {pendingStep.output.media?.kind === 'image' && (
              <img className="wf-step-thumb" src={pendingStep.output.media.url} alt="这一步的图" />
            )}
            {pendingStep.output.media?.kind === 'video' && (
              <video className="wf-step-thumb" src={pendingStep.output.media.url} controls />
            )}
            {(pendingStep.output.text ?? '') !== '' && (
              <pre className="wf-step-text" data-testid="wf-step-text">
                {(pendingStep.output.text ?? '').slice(0, 600)}
                {(pendingStep.output.text ?? '').length > 600 ? '…' : ''}
              </pre>
            )}
            {pendingStep.output.warning && (
              <p className="wf-node-warning">{pendingStep.output.warning}</p>
            )}
          </div>
          <div className="wf-step-actions">
            <button
              type="button"
              className="wf-primary"
              data-testid="wf-step-continue"
              onClick={() => answerStep('continue')}
            >
              继续
            </button>
            <button type="button" data-testid="wf-step-retry" onClick={() => answerStep('retry')}>
              重跑此步
              {pendingStep.output.media ? '（会再问一次费用）' : ''}
            </button>
            <button type="button" data-testid="wf-step-abort" onClick={() => answerStep('abort')}>
              中止
            </button>
            <span className="wf-hint">中止 = 停止：后面的节点一个请求都不发。</span>
          </div>
        </div>
      )}

      {inspector && (
        <aside className="wf-inspector" role="dialog" aria-label="节点检查器">
          <header className="wf-inspector-head">
            <div>
              <p className="wf-modal-title">{inspector.label}</p>
              <p className="wf-modal-sub">
                {inspector.packId ? `提示词包：${inspector.packId}` : '节点'}
                {inspector.status !== 'idle' ? ` · 状态：${inspector.status}` : ''}
              </p>
            </div>
            <button
              type="button"
              className="wf-inspector-close"
              aria-label="关闭"
              onClick={() => useWorkflowStore.getState().closeInspector()}
            >
              ×
            </button>
          </header>

          {inspector.packId && (
            <>
              <p className="wf-inspector-label">实际发给模型的 system prompt（全文）</p>
              <p className="wf-inspector-usage" data-testid="wf-custom-usage">
                当前使用：<strong>{inspector.custom ? inspector.custom.name : '内置'}</strong>
              </p>
            </>
          )}

          {inspector.packId && editing && inspector.parts ? (
            <>
              <label className="wf-field">
                <span>副本名</span>
                <input
                  className="wf-input"
                  data-testid="wf-custom-name"
                  aria-label="副本名"
                  value={draftName}
                  onChange={(event) => {
                    setDraftName(event.target.value);
                    setFormError(null);
                  }}
                />
              </label>
              <label className="wf-field">
                <span>提示词正文</span>
                <textarea
                  className="wf-textarea"
                  rows={12}
                  data-testid="wf-custom-body"
                  aria-label="提示词正文"
                  value={draftBody}
                  onChange={(event) => {
                    setDraftBody(event.target.value);
                    setFormError(null);
                  }}
                />
              </label>

              <div className="wf-inspector-rules">
                <p className="wf-inspector-label">由系统维护，不随副本修改</p>
                <p className="wf-hint">
                  副本只替换正文。下面两段是机器校验契约：改了它们，模型输出会被直接判为不合格。
                </p>
                <p className="wf-inspector-label">校验清单</p>
                <ul className="wf-inspector-fields">
                  {inspector.parts.validation.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
                <p className="wf-inspector-label">硬禁止</p>
                <ul className="wf-inspector-fields">
                  {inspector.parts.forbidden.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>

              {formError && (
                <p className="wf-form-error" role="alert" data-testid="wf-custom-error">
                  {formError}
                </p>
              )}

              <div className="wf-inspector-actions">
                <button
                  type="button"
                  className="wf-primary"
                  data-testid="wf-custom-save"
                  onClick={() => void saveDraft()}
                  disabled={saving}
                >
                  保存
                </button>
                <button type="button" onClick={cancelEditing} disabled={saving}>
                  取消
                </button>
                {inspector.custom && (
                  <button type="button" onClick={() => void restoreBuiltin()} disabled={saving}>
                    还原为内置
                  </button>
                )}
                {inspector.custom && (
                  <button
                    type="button"
                    data-testid="wf-custom-remove"
                    onClick={() => setConfirmRemove(true)}
                    disabled={saving}
                  >
                    删除副本
                  </button>
                )}
              </div>

              {confirmRemove && inspector.custom && (
                <div className="wf-confirm-inline" role="alertdialog" aria-label="删除副本">
                  <p className="wf-hint">
                    删除「{inspector.custom.name}」后，这个提示词包立即回到内置正文；已导出的备份里那份还在。
                  </p>
                  <div className="wf-inspector-actions">
                    <button type="button" onClick={() => setConfirmRemove(false)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="wf-danger"
                      data-testid="wf-custom-remove-confirm"
                      onClick={() => void deleteCustom()}
                      disabled={saving}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : inspector.packId ? (
            <>
              <pre className="wf-inspector-prompt" data-testid="wf-pack-prompt">
                {inspector.systemPrompt}
              </pre>

              <p className="wf-inspector-label">输出结构（字段名）</p>
              <ul className="wf-inspector-fields">
                {inspector.fields.map((field) => (
                  <li key={field}>
                    <code>{field}</code>
                  </li>
                ))}
              </ul>

              <div className="wf-inspector-actions">
                <button type="button" onClick={() => void copyPrompt()}>
                  复制全文
                </button>
                <button type="button" data-testid="wf-custom-start" onClick={startEditing}>
                  另存为副本并编辑
                </button>
              </div>
              <p className="wf-hint">
                副本只改正文（校验清单与硬禁止由系统维护）。保存后，凡是用这个提示词包的节点都会换成你的正文。
              </p>
            </>
          ) : null}

          {/* §3.1：每个节点都能看到自己这一步的完整结果 */}
          <section className="wf-inspector-output" data-testid="wf-node-inspector-output">
            <p className="wf-inspector-label">这一步的结果</p>
            {inspector.outputText === '' && inspector.mediaUrl === '' ? (
              <p className="wf-hint">
                还没跑过：点「运行」（或这个节点的上游先跑一次）之后，结果会显示在这里。
              </p>
            ) : (
              <>
                {inspector.mediaUrl !== '' && inspector.mediaKind === 'image' && (
                  <img className="wf-inspector-image" src={inspector.mediaUrl} alt="这一步的完整图" />
                )}
                {inspector.mediaUrl !== '' && inspector.mediaKind === 'video' && (
                  <video className="wf-inspector-video" src={inspector.mediaUrl} controls />
                )}
                {inspector.mediaUrl !== '' && (
                  <p className="wf-hint">
                    <a href={inspector.mediaUrl} target="_blank" rel="noreferrer">
                      在新窗口打开原文件
                    </a>
                  </p>
                )}
                {inspector.outputText !== '' && (
                  <>
                    <pre className="wf-inspector-text" data-testid="wf-inspector-text">
                      {inspector.outputText}
                    </pre>
                    <div className="wf-inspector-actions">
                      <button type="button" data-testid="wf-copy-output" onClick={() => void copyOutput()}>
                        复制
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {inspector.warning && <p className="wf-node-warning">{inspector.warning}</p>}
            {inspector.nodeError && <p className="wf-node-error">{inspector.nodeError}</p>}
          </section>
        </aside>
      )}

      {pendingQuote && (
        <div className="wf-modal-backdrop" role="dialog" aria-modal="true" aria-label="费用确认">
          <div className="wf-modal">
            <p className="wf-modal-title">{costConfirmText(pendingQuote)}</p>
            <p className="wf-modal-sub">
              {pendingQuote.kind === 'image' ? '生图' : '生视频'} · {pendingQuote.modelId}
            </p>
            <ul className="wf-modal-notices">
              {pendingQuote.notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
            <div className="wf-modal-actions">
              <button type="button" onClick={() => answerConfirm(false)}>
                取消（不发请求）
              </button>
              <button type="button" className="wf-primary" onClick={() => answerConfirm(true)}>
                确认并继续
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
