/**
 * 工作流执行器（M5b2：DAG，仍**顺序**执行；M5b4：可逐节点暂停等人）。
 *
 * 四条硬规矩（M5b4 一条都没松）：
 * 1. **顺序执行，不并行**：拓扑序 + 逐个 await。一对多不是"并行尝试"，是"同一个上游结果
 *    被下游多处复用"——上游只跑一次，省的是真金白银；
 * 2. **每个节点只执行一次**：`outputs` 按 nodeId 缓存，下游从缓存里读（`outputOf`）。
 *    判据里"一对多时上游只被调用一次"就钉在这条上；
 * 3. **失败不蔓延**：任一上游 error/skipped → 本节点直接 skipped，**一个请求都不发**；
 * 4. **不在节点里等人**：每个节点吃一次输入、出一次结果（委托人的裁决："工作流只做单次"）。
 *
 * M5b4 的「每步确认」怎么加才不破坏上面四条：
 * 加一个 `onNodeDone` 回调，**在本节点已经跑完、下一个节点开始之前** await 它。
 * 这不是"事件驱动"、也不是"可乱序"——它只是把循环体从"跑完就走"改成"跑完问一句再走"：
 * - `continue` → 照原样进下一个节点；
 * - `retry` → 用**同一个节点的同一份输入**再跑一遍（成本闸门会再问一次），下游仍然只跑一次；
 * - `abort` → 等价于"停止"：后续节点全部 skipped，一个请求都不发。
 *
 * 执行器本身**不认识**任何厂商：跑 pack、生图、生视频、算钱、弹确认、读素材，全部由 `ExecuteDeps`
 * 注入（UI 注入真实现，测试注入 mock）。所以"未确认费用 → 零请求""有环 → 零请求"
 * 这类判据能在不碰网络的前提下断言。
 */

import type { Issue } from '../../packs/validate';
import { resolveEdges, validateWorkflowGraph } from './graph';
import type { ResolvedEdge } from './graph';
import { MERGE_SEPARATOR } from './types';
import type { ExecEdge, ExecNode, WFNodeData, WFStatus } from './types';

export interface MediaRef {
  kind: 'image' | 'video';
  /** 浏览器里能直接用的地址（通常是 blob:） */
  url: string;
  mimeType: string;
  artifactId?: string;
  /** 落盘用的 media 表主键（视频首帧要读字节时用得上） */
  blobId?: string;
  /**
   * 公网地址（M5b4）：参考视频只认 http(s) URL（方舟不接受 Base64）——
   * 本地文件只有 `url`（blob:），没有 `publicUrl` 时执行器要**如实报错**，不能假装传上去了。
   */
  publicUrl?: string;
  /** 展示用（上传的文件名 / 产物摘要） */
  name?: string;
  size?: number;
}

export interface NodeOutput {
  /** 文本结果（source / merge / pack / output 用） */
  text?: string;
  /** 媒体结果（image / video / imageSource / videoSource 用） */
  media?: MediaRef;
  /** pack 校验器的硬问题（为空 = 合格） */
  issues?: Issue[];
  warning?: string;
}

export interface CostQuote {
  nodeId: string;
  kind: 'image' | 'video';
  /** 元；免费档是 0 */
  amount: number;
  /** 界面上一行：模型名 + 规格 */
  modelId: string;
  spec: string;
  free: boolean;
  /** 必须同屏展示的额外提示（视频节点有"本地停止不阻止服务端计费"） */
  notices: string[];
}

/** 每步确认的三种回答（任务书 §3.2 的三个按钮） */
export type NodeDoneVerdict = 'continue' | 'retry' | 'abort';

export interface ExecuteDeps {
  /** 读记录正文（source 节点绑定了 recordId 时） */
  readRecordText?: (recordId: string) => Promise<string>;
  /** 跑一个 pack；抛错 = 这个节点失败 */
  runPack: (node: ExecNode, text: string) => Promise<{ text: string; issues?: Issue[] }>;
  /** 生图；reference 来自「参考图」口（适配器不支持时执行器会忽略并在节点上提示） */
  runImage: (node: ExecNode, prompt: string, reference?: MediaRef) => Promise<NodeOutput>;
  /** 生视频；firstFrame 来自「首帧图」口，referenceVideo 来自「参考视频」口（M5b4 新增第 4 参） */
  runVideo: (
    node: ExecNode,
    prompt: string,
    firstFrame?: MediaRef,
    referenceVideo?: MediaRef,
  ) => Promise<NodeOutput>;
  /** 生图适配器能不能吃参考图（当前三家官方接口都没有这个字段 → 默认 false） */
  imageReferenceSupported?: boolean;
  /** 读「图片源 / 视频源」节点指向的素材（artifacts 或 media 里的那条） */
  readSource?: (node: ExecNode) => Promise<MediaRef>;
  /**
   * 当前视频模型不支持参考视频时返回一句人话（`null` = 支持）。
   * 挂在这里而不是在执行器里判断厂商：能力是适配器的事实，执行器不认识任何厂商。
   */
  referenceVideoSupported?: (node: ExecNode) => string | null;
  /** 预估费用；返回 null = 这个节点不用问（例如模型没选，交给 runX 抛错） */
  quote?: (node: ExecNode) => CostQuote | null;
  /** 必须点确认才继续；返回 false = 不发请求 */
  confirm?: (quote: CostQuote) => Promise<boolean>;
  /** 每步写回节点状态（UI 实时亮） */
  onStatus?: (nodeId: string, patch: Partial<WFNodeData>) => void;
  /** 节点成功后把输出交出去（UI 立刻挂到节点上：摘要 / 缩略图 / 首帧） */
  onOutput?: (nodeId: string, output: NodeOutput) => void;
  /**
   * 每步确认（M5b4）：**只有传了才逐节点暂停**（不传 = 自动跑完，与 M5b3 完全一致）。
   * 返回 `retry` 只重跑当前节点（同一份输入、成本闸门会再问一次），下游仍只跑一次。
   */
  onNodeDone?: (nodeId: string, output: NodeOutput) => Promise<NodeDoneVerdict>;
  /** 用户点了停止（执行器在每个节点边界与每次 await 之后检查） */
  isStopped?: () => boolean;
}

export interface NodeRunState {
  status: WFStatus;
  error?: string;
  warning?: string;
}

export interface WorkflowRunResult {
  order: string[];
  states: Record<string, NodeRunState>;
  outputs: Record<string, NodeOutput | undefined>;
  stopped: boolean;
  /** 用户拒绝付费的节点（判据：这些节点必须零请求） */
  declined: string[];
  /** 用户在「每步确认」里点了中止（与"停止"等价，但单独记一笔便于界面区分） */
  aborted: boolean;
}

const STOP_BEFORE = '已停止：未开始';
const STOP_DURING = '运行中被停止，结果已丢弃';
const IMAGE_REF_IGNORED = '当前生图模型不支持参考图：reference 口的图已忽略';

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** 按端口顺序拼接（「文本合并」的语义：显式、可预期，不做隐式合并） */
export function mergeTexts(
  parts: Array<{ port: string; label: string; text: string }>,
  separator: string,
  labelParts: boolean,
): string {
  const filled = parts.filter((part) => part.text.trim() !== '');
  if (!labelParts) return filled.map((part) => part.text.trim()).join(separator);
  return filled
    .map((part, index) => `【素材${index + 1}】\n${part.text.trim()}`)
    .join(separator);
}

/** 单次尝试的结局（不掺 UI 状态，"谁写状态"只在主循环里做一次） */
type Attempt =
  | { kind: 'ok'; output: NodeOutput }
  | { kind: 'skipped'; reason: string; declined?: boolean }
  | { kind: 'error'; error: string };

export async function executeWorkflow(
  nodes: readonly ExecNode[],
  edges: readonly ExecEdge[],
  deps: ExecuteDeps,
): Promise<WorkflowRunResult> {
  // ① 校验图（端口/类型/一口一线/有环/必填输入）+ ② 拓扑排序
  // 图不合法时在这里就抛，deps 里任何处理器都不会被调用
  const order = validateWorkflowGraph(nodes, edges);
  const resolved: ResolvedEdge[] = resolveEdges(nodes, edges);

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  /** targetId → (targetPort → 上游) */
  const incoming = new Map<string, Map<string, ResolvedEdge>>();
  for (const edge of resolved) {
    const ports = incoming.get(edge.target) ?? new Map<string, ResolvedEdge>();
    ports.set(edge.targetPort, edge);
    incoming.set(edge.target, ports);
  }

  const states: Record<string, NodeRunState> = {};
  for (const node of nodes) states[node.id] = { status: 'idle' };

  /** 结果缓存：一个节点跑一次，多个下游读同一份（一对多只花一次钱） */
  const outputs: Record<string, NodeOutput | undefined> = {};
  const executed = new Set<string>();
  const declined: string[] = [];

  const outputOf = (nodeId: string | undefined): NodeOutput | undefined =>
    nodeId === undefined ? undefined : outputs[nodeId];

  const stopped = (): boolean => deps.isStopped?.() === true;

  const mark = (id: string, status: WFStatus, extra: Partial<NodeRunState> = {}): void => {
    states[id] = { status, ...extra };
    deps.onStatus?.(id, { status, error: extra.error, warning: extra.warning });
  };

  const skip = (id: string, reason: string): void => {
    mark(id, 'skipped', { error: reason });
  };

  /** 取某个输入口上的上游（没有 = 这个口没连） */
  const upstreamOfPort = (nodeId: string, port: string): ResolvedEdge | undefined =>
    incoming.get(nodeId)?.get(port);

  const textAt = (nodeId: string, port: string): string => {
    const edge = upstreamOfPort(nodeId, port);
    return outputOf(edge?.source)?.text ?? '';
  };

  const mediaAt = (nodeId: string, port: string): MediaRef | undefined => {
    const edge = upstreamOfPort(nodeId, port);
    return outputOf(edge?.source)?.media;
  };

  /** 跑一个节点**一次**（不含状态簿记与重试；重试靠主循环再来一次这个函数） */
  const runOnce = async (node: ExecNode): Promise<Attempt> => {
    const id = node.id;
    try {
      const type = node.type;

      if (type === 'source') {
        const data = node.data;
        let text = (data.text ?? '').trim();
        if (data.recordId && deps.readRecordText) {
          const fromRecord = (await deps.readRecordText(data.recordId)).trim();
          if (fromRecord !== '') text = fromRecord;
        }
        if (stopped()) return { kind: 'skipped', reason: STOP_DURING };
        if (text === '') throw new Error('文本源是空的：写一段文字，或选一条记录');
        return { kind: 'ok', output: { text } };
      }

      if (type === 'merge') {
        const parts = [
          { port: 'text1', label: '素材 1' },
          { port: 'text2', label: '素材 2' },
          { port: 'text3', label: '素材 3' },
          { port: 'text4', label: '素材 4' },
        ]
          .filter((item) => upstreamOfPort(id, item.port) !== undefined)
          .map((item) => ({ ...item, text: textAt(id, item.port) }));

        if (parts.every((part) => part.text.trim() === '')) {
          throw new Error('「文本合并」没拿到任何文本：把素材接到它的输入口上');
        }
        const separator = node.data.separator ?? MERGE_SEPARATOR;
        const text = mergeTexts(parts, separator, node.data.labelParts === true);
        return { kind: 'ok', output: { text } };
      }

      if (type === 'pack') {
        const upstreamText = textAt(id, 'text');
        if (upstreamText.trim() === '') {
          throw new Error('上游没有给到文本：提示词包需要一个文本源');
        }
        const result = await deps.runPack(node, upstreamText);
        if (stopped()) return { kind: 'skipped', reason: STOP_DURING };
        const issues = result.issues ?? [];
        const warning =
          issues.length > 0
            ? `输出有 ${issues.length} 处不合格：${issues
                .slice(0, 3)
                .map((issue) => issue.message)
                .join('；')}`
            : undefined;
        return { kind: 'ok', output: { text: result.text, issues, warning } };
      }

      if (type === 'imageSource' || type === 'videoSource') {
        if (!deps.readSource) {
          throw new Error('这个环境没有接「读素材」：图片源 / 视频源无法执行');
        }
        const media = await deps.readSource(node);
        if (stopped()) return { kind: 'skipped', reason: STOP_DURING };
        const want: MediaRef['kind'] = type === 'imageSource' ? 'image' : 'video';
        if (media.kind !== want) {
          throw new Error(
            `「${want === 'image' ? '图片源' : '视频源'}」读到的是 ${media.mimeType || media.kind}：类型不对`,
          );
        }
        return { kind: 'ok', output: { media } };
      }

      if (type === 'image' || type === 'video') {
        const data = node.data;
        const fromUpstream = data.promptFromUpstream !== false;
        const prompt = fromUpstream ? textAt(id, 'prompt').trim() : (data.text ?? '').trim();
        if (prompt === '') {
          throw new Error('没有提示词：先接一个文本源，或在节点里写提示词');
        }

        // ④ 成本闸门：先算钱、必须点确认（**每次尝试都走一遍** → 重跑会再问一次）
        const quote = deps.quote?.(node) ?? null;
        if (quote && deps.confirm) {
          const approved = await deps.confirm(quote);
          if (stopped()) return { kind: 'skipped', reason: STOP_DURING };
          if (!approved) {
            return {
              kind: 'skipped',
              declined: true,
              reason: `未确认本次花费（${quote.spec}），未发送请求`,
            };
          }
        }

        if (type === 'image') {
          const reference = mediaAt(id, 'reference');
          if (reference && deps.imageReferenceSupported !== true) {
            // 适配器签名里没有参考图字段：**忽略**并明确告诉用户，不假装用了
            const output = await deps.runImage(node, prompt);
            if (stopped()) return { kind: 'skipped', reason: STOP_DURING };
            return {
              kind: 'ok',
              output: {
                ...output,
                warning: [output.warning, IMAGE_REF_IGNORED].filter(Boolean).join('；'),
              },
            };
          }
          const output = await deps.runImage(node, prompt, reference);
          if (stopped()) return { kind: 'skipped', reason: STOP_DURING };
          return { kind: 'ok', output };
        }

        const referenceVideo = mediaAt(id, 'referenceVideo');
        if (referenceVideo) {
          // 能力裁剪：不支持就**显式拒绝**（任务书明令禁止静默忽略）
          const blocker = deps.referenceVideoSupported?.(node) ?? null;
          if (blocker !== null) throw new Error(blocker);
        }
        const output = await deps.runVideo(node, prompt, mediaAt(id, 'firstFrame'), referenceVideo);
        if (stopped()) return { kind: 'skipped', reason: STOP_DURING };
        return { kind: 'ok', output };
      }

      if (type === 'output') {
        // 三个分类型输入口：文本可以多条（拼接），图片/视频取第一条
        const textPorts = ['text'];
        const text = textPorts
          .filter((port) => upstreamOfPort(id, port) !== undefined)
          .map((port) => textAt(id, port).trim())
          .filter((part) => part !== '')
          .join('\n\n');
        const media = mediaAt(id, 'image') ?? mediaAt(id, 'video');

        if (text === '' && media === undefined) {
          throw new Error('输出节点没有拿到上游结果');
        }
        return { kind: 'ok', output: { text: text === '' ? undefined : text, media } };
      }

      throw new Error(`未知的节点类型：${type}`);
    } catch (caught) {
      return { kind: 'error', error: errorText(caught) };
    }
  };

  let wasStopped = false;
  let aborted = false;

  for (const id of order) {
    if (wasStopped || aborted || stopped()) {
      wasStopped = true;
      skip(id, STOP_BEFORE);
      continue;
    }

    const node = nodeById.get(id) as ExecNode;
    const portsIn = incoming.get(id);

    // ③ 失败传播：任一上游 error/skipped → 本节点跳过，不发任何请求
    const failedUpstream = portsIn
      ? [...portsIn.values()].find((edge) => {
          const state = states[edge.source];
          return state?.status === 'error' || state?.status === 'skipped';
        })
      : undefined;
    if (failedUpstream) {
      skip(id, `上游 ${failedUpstream.source} 失败或跳过，本节点未执行`);
      continue;
    }

    // 防御：拓扑序保证每个节点只出现一次；真出现第二次就直接报，不重复花钱
    if (executed.has(id)) {
      mark(id, 'error', { error: '内部错误：同一个节点被执行了两次' });
      continue;
    }
    executed.add(id);

    /**
     * 单个节点的「跑 → 可能重跑 → 定状态」。
     * `retry` 只回到这个 while 的开头：`executed` 已经记过，下游不受影响。
     */
    for (;;) {
      mark(id, 'running');
      const attempt = await runOnce(node);

      if (attempt.kind === 'skipped') {
        if (attempt.declined === true) declined.push(id);
        skip(id, attempt.reason);
        break;
      }
      if (attempt.kind === 'error') {
        mark(id, 'error', { error: attempt.error });
        break;
      }

      outputs[id] = attempt.output;
      const warning = attempt.output.warning;
      mark(id, 'ok', warning === undefined ? {} : { warning });
      deps.onOutput?.(id, attempt.output);

      if (!deps.onNodeDone) break;

      let verdict: NodeDoneVerdict;
      try {
        verdict = await deps.onNodeDone(id, attempt.output);
      } catch (caught) {
        // 等人那边的 Promise 出错（例如页面被卸载）：按"中止"处理，不静默继续
        mark(id, 'ok', { warning: `每步确认出错：${errorText(caught)}` });
        verdict = 'abort';
      }

      if (verdict === 'retry') {
        delete outputs[id]; // 重跑期间下游还看不到这份结果（虽然此刻还没轮到它们）
        continue;
      }
      if (verdict === 'abort') {
        aborted = true;
        wasStopped = true;
      }
      break;
    }
  }

  return { order, states, outputs, stopped: wasStopped || stopped(), declined, aborted };
}
