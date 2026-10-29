/**
 * 「测试连通」的真实决策树（M3R9 §1 / §2）。
 *
 * 为什么单独一个模块：自检不再是一个 POST，而是「先看这把 key 到底能用什么 → 选一个
 * 能发同步 chat 的模型 → 才发请求」。这段编排既要在 UI 里跑，也要能用 mock server
 * 直接测（判据 §6 的 1 / 2 / 3 / 4 / 5 / 7 全在这层断言），所以从组件里抽出来。
 *
 * 改造前的三条毛病（承接方真机实测，三家厂商全不可用）：
 * ① 硬编码用 `VENDOR_META` 的默认模型，而不是「这个 key 实际能用的模型」；
 * ② 不区分模型能力，对生图/视频模型也发同步 chat；
 * ③ 服务端业务码（1212 / model_not_allowed）没有映射成可执行提示。
 *
 * 决策树：
 * ```
 * ① 能力预检（发请求之前）
 *    - 模型表非空、但一条 text/vision 都没有 → NO_SYNC_MODEL，**零请求**
 *    - 用户手动选中的那一行是生图/视频       → NO_SYNC_MODEL，**零请求**
 * ② 拿「这个 key 能用什么」：GET 模型列表（原样地址 → 补 /v1，任一成功即停）
 *    - 200 → 列表里第一个文本模型（跳过 image/video/vidu/seedance/cogview/cogvideo 前缀）
 *    - 失败 → 退回模型表里的文本模型；模型表也没有 → 可执行提示（仍然不发同步请求）
 * ③ 按【协议 + 模型】发一次同步请求（max_tokens = 1，body 只有一句 "ping"）
 * ④ 结果里带上「用的是哪个模型」与「实际命中的地址」
 * ```
 *
 * 与任务书的一处取舍：§1 的正文顺序是「先拉列表」，② 的正文顺序是「先用模型表里选中的」。
 * 两者冲突时按**真实故障**取：灵绘那把 key 的 claude-opus-5-5 没权限，而站上给出的
 * gemini-3.8-flash 可用 —— 所以列表能拿到时**列表优先**（这正是「按 key 的真实能力」），
 * 列表拿不到时才退回模型表。用户手动选中生图/视频那一行仍然**优先拦下**（§2 明文要求）。
 */
import { listModels as listModelsApi, pickListedTextModel, runSelfTest } from './client';
import type {
  ClientProtocol,
  ListModelsResult,
  ProbeResult,
  ProviderInput,
  SyncCandidate,
} from './client';
import { AIErrorCode } from './types';
import { USER_MESSAGES, makeError } from './errors';
import { canSyncTest } from './client';

export interface ConnectionSelfTestInput {
  baseUrl: string;
  apiKey: string;
  protocol?: ClientProtocol;
  timeoutMs?: number;
  /** 用户手动选中（最近点过/编辑过）的那一行；没有明确选中就传 undefined */
  selectedModel?: SyncCandidate;
  /** 当前连接的整张模型表（用来判断「这条连接里有哪些能力」） */
  connectionModels?: readonly SyncCandidate[];
}

export interface ConnectionSelfTestDeps {
  selfTest?: (input: ProviderInput) => Promise<ProbeResult>;
  listModels?: (input: ProviderInput) => Promise<ListModelsResult>;
}

export interface ConnectionSelfTestOutcome {
  /** 与 `runSelfTest` 同形：UI 只认这一个结果（成功 / 失败 / 技术细节都从它取） */
  probe: ProbeResult;
  /** 过程中那次「拉列表」（真的发了才有）；UI 可以据此提示「已从站上取到 N 个模型」 */
  listing?: ListModelsResult;
  /**
   * 有没有真的发出同步请求。测试据此断言「零请求」——§2 的硬要求，
   * 也是「别拿生图模型去烧一次 400」的成本约束。
   */
  sentSyncRequest: boolean;
}

/** §2 的原文提示（这条连接里只有生图/视频模型） */
export const NO_SYNC_MODEL_MESSAGE = USER_MESSAGES[AIErrorCode.NO_SYNC_MODEL];

/** 模型表里一个可用文本模型都没有时的话（模型表是空的、或全是生图/视频） */
export const NO_TEXT_MODEL_IN_CONNECTION =
  '这条连接里还没有可用的文本模型：点下面的文本模型标签（如 glm-5.3-flash / deepseek-flash）再测，或先点「拉取模型列表」从站上取一个。';

function noSyncModelProbe(userMessage: string, message: string): ProbeResult {
  return {
    ok: false,
    url: '',
    status: 0,
    elapsedMs: 0,
    error: makeError(AIErrorCode.NO_SYNC_MODEL, message, { userMessage }),
    diagnostics: {
      method: '',
      url: '',
      status: 0,
      elapsedMs: 0,
      errorName: '-',
      bodyPreview: '',
      attemptedUrls: [],
    },
  };
}

/**
 * 跑一次「按 key 真实能力」的连通性自检。**不抛异常**：注入的函数抛了就当成一次失败结果，
 * 免得一个网络抖动把整个配置页打挂。
 */
export async function runConnectionSelfTest(
  input: ConnectionSelfTestInput,
  deps: ConnectionSelfTestDeps = {},
): Promise<ConnectionSelfTestOutcome> {
  const base = {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    protocol: input.protocol,
    syncCandidates: input.connectionModels,
  };
  const probe = deps.selfTest ?? ((probeInput: ProviderInput) => runSelfTest(probeInput));
  const list = deps.listModels ?? ((probeInput: ProviderInput) => listModelsApi(probeInput));

  const table = input.connectionModels ?? [];
  const syncableInTable = table.filter((item) => canSyncTest(item.modelId, item.caps));

  /* ① 能力预检 ------------------------------------------------------- */
  // 模型表里有东西，但一条 text/vision 都没有 → 别把生图/视频模型丢给同步 chat
  if (table.length > 0 && syncableInTable.length === 0) {
    return {
      probe: noSyncModelProbe(
        NO_SYNC_MODEL_MESSAGE,
        `连接的 ${table.length} 个模型都过不了同步自检：${table.map((item) => item.modelId).join(', ')}`,
      ),
      sentSyncRequest: false,
    };
  }
  // 用户手动选中的那一行是生图/视频 → 同样**不发请求**（§2 明文要求「同上提示」）。
  // 这时连接里可能另有文本模型，所以措辞要点明「你选中的这个」而不是「这条连接里只有」。
  const selected = input.selectedModel;
  if (selected && !canSyncTest(selected.modelId, selected.caps)) {
    return {
      probe: noSyncModelProbe(
        `选中的模型 ${selected.modelId} 是生图/视频模型，不支持同步自检。请点下面的文本模型标签（如 glm-5.3-flash / deepseek-flash）再测，或直接到创作页实测。`,
        `选中的模型 ${selected.modelId} 不支持同步 chat（caps 里没有 text/vision）`,
      ),
      sentSyncRequest: false,
    };
  }

  /* ② 拿「这个 key 能用什么」 ----------------------------------------- */
  let listing: ListModelsResult | undefined;
  let model = '';
  let modelSource: 'listed' | 'connection' = 'connection';

  try {
    listing = await list({ ...base, model: '' });
  } catch (error) {
    // 注入的拉列表实现炸了：当成「这家拿不到列表」，继续走退回路径
    listing = {
      ok: false,
      models: [],
      url: input.baseUrl,
      error: makeError(
        AIErrorCode.NETWORK_ERROR,
        `拉取模型列表时抛异常：${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  if (listing.ok) {
    const listed = pickListedTextModel(listing.models);
    if (listed) {
      model = listed;
      modelSource = 'listed';
    }
  }
  if (model === '') {
    // 列表拿不到（方舟就是这样）或列表里挑不出文本模型 → 用模型表里的文本模型
    const fromTable = syncableInTable.find((item) => item.modelId.trim() !== '');
    if (fromTable) {
      model = fromTable.modelId.trim();
      modelSource = 'connection';
    }
  }
  if (model === '') {
    // 既没有列表、模型表里也没有可用的文本模型 → 明确告诉用户点哪个标签（仍然不发同步请求）
    const reason = listing.ok
      ? `站上拉到的 ${listing.models.length} 个模型里没有可用的文本模型`
      : `拉不到模型列表（${listing.error?.message ?? '原因未知'}），模型表里也没有文本模型`;
    return {
      probe: {
        ok: false,
        url: listing.url,
        status: 0,
        elapsedMs: 0,
        error: makeError(AIErrorCode.MODEL_NOT_FOUND, reason, {
          userMessage: NO_TEXT_MODEL_IN_CONNECTION,
        }),
      },
      listing,
      sentSyncRequest: false,
    };
  }

  /* ③ 按【协议 + 模型】发一次同步请求 --------------------------------- */
  const result = await probe({ ...base, model });
  return {
    // testedModel 兜底成「刚才请求里用的那个」：注入的假探针不一定填这个字段，
    // 而 UI 必须能显示「是用哪个模型测的」（§1-④）
    probe: {
      ...result,
      testedModel: result.testedModel ?? model,
      modelSource: result.modelSource ?? modelSource,
    },
    listing,
    sentSyncRequest: true,
  };
}
