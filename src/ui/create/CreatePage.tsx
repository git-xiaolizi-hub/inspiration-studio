/**
 * 创作页 `/#/create?recordId=xxx`（M5a2 起；M5a3 把 解梦/灵感 改成会话）。
 *
 * 四个 tab：解梦 / 灵感与文案 / 生图 / 生视频。
 * - 解梦、灵感与文案：**首轮**走 `runPackInBrowser`（结构化、必过校验器）→ 写成线程的第一轮；
 *   **追问**走 `chat()`（自由文本，不做 JSON 校验）。线程存 `threads` 表，刷新/换设备（备份）都跟着走；
 * - 生图：`adapterForModel` 挑适配器 → 生成 → 立刻下载落盘 → 写一条 artifact（**保持单次**）；
 * - 生视频：**就地出面板**（`VideoGenerationSection`，原独立视频页的正文），不再跳 `/#/video`
 *   —— P2 删掉了 `/video`：委托方的意思是「视频页是冗余，应该加入单卡创作」。
 *
 * P2 起 `/create` **不带 `recordId` 时不再是这个页面**：`CreateRoute` 会分流到创作入口页
 * （`CreateHub`，三块磁贴）。`/create?recordId=xxx` 的深链行为一个字没变。
 *
 * 硬约定（UI-SKELETON §2/§3）：
 * - 模型一律来自 `listModelsByCap`，默认值取 `pickModel(cap)`；本页的临时覆盖**不写回配置**；
 * - 费用只出现在生成按钮旁的小字里（不设独立面板）；
 * - 能力缺失给可执行提示，并且**不渲染空按钮**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  activeConnectionFor,
  capHint,
  listModelsByCap,
  loadCatalog,
  pickModel,
} from '../../adapters/ai-models/catalog';
import type { AICatalog, ModelCap, VideoModelRef } from '../../adapters/ai-models/catalog';
import { chat } from '../../adapters/ai-models/client';
import { loadAIConfig, loadPriceTable, loadSpend, recordSpend } from '../../adapters/ai-models/config-store';
import {
  OFFICIAL_PRICE_TABLE,
  checkBudget,
  estimateImage,
  estimateText,
  formatYuan,
  priceKeyForTextModel,
} from '../../adapters/ai-models/pricing';
import type { PriceTable } from '../../adapters/ai-models/pricing';
import { AbstractImageAdapter } from '../../adapters/image/base-adapter';
import { adapterForModel, imagePriceFor } from '../../adapters/image/channels';
import { MAX_IMAGE_COUNT } from '../../adapters/image/constants';
import { imageBlobId, getStoredImage } from '../../adapters/image/storage';
import type { ImageAdapter, ImageAspect } from '../../adapters/image/types';
import { saveArtifact } from '../../core/artifacts';
import { getRecordEntity } from '../../core/records';
import {
  contextTurns,
  createThread,
  listThreadsByKind,
  setThreadTurns,
  structuredToText,
  toChatMessages,
} from '../../core/threads';
import type { Thread, ThreadKind, Turn } from '../../core/threads';
import { hydrateCustomPrompts } from '../../core/custom-prompts';
import { ArtifactCard } from './ArtifactCards';
import type { ArtifactItem } from './ArtifactCards';
import { loadBrowserPack, buildFollowUpSystemPrompt, runPackInBrowser } from './pack-runner';
import type { PackPrompt } from './pack-runner';
import { contextBudget, estimateConversationTokens, DEFAULT_CONTEXT_WINDOW } from './context-budget';
import { ThreadView } from './ThreadView';
import { CreateHub } from './CreateHub';
import { VideoGenerationSection } from '../video/VideoGenerationSection';
import { useRecordArtifacts } from './useRecordArtifacts';
import './create.css';

export type CreateTabId = 'dream' | 'copy' | 'image' | 'video' | 'audio';

/**
 * R7a：加入「音频 · 即将支持」。
 *
 * `audio` 这一版**只做到「能配置、能显示」**：AI 配置里可以给模型打上「音频」标签、
 * 角色里可以指定 audio 模型；但创作页的生成链路（TTS / 配音 / 音乐）还没接，
 * 所以 tab 必须**禁用** —— 不许放一个点了没反应的假生成按钮。
 */
export const CREATE_TABS: ReadonlyArray<{
  id: CreateTabId;
  label: string;
  cap: ModelCap;
  disabled?: boolean;
}> = [
  { id: 'dream', label: '解梦', cap: 'text' },
  { id: 'copy', label: '灵感与文案', cap: 'text' },
  { id: 'image', label: '生图', cap: 'image' },
  { id: 'video', label: '生视频', cap: 'video' },
  { id: 'audio', label: '音频 · 即将支持', cap: 'audio', disabled: true },
];

/** 文字生成：默认实现走 `chat()`；测试注入假实现（返回字符串或 {text, cost}） */
export type TextGenerator = (prompt: PackPrompt) => Promise<string | { text: string; cost?: number }>;

/** 追问（M5a3）：system = pack 提示词 + 记录正文，messages = 本线程全部有效轮 + 本次提问 */
export interface FollowUpPrompt {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface FollowUpResult {
  text: string;
  cost?: number;
  tokens?: number;
}

/** 追问生成器：默认实现走 `chat()`；测试注入假实现（断言 messages 顺序 / system 含正文） */
export type FollowUpGenerator = (prompt: FollowUpPrompt) => Promise<FollowUpResult>;

export interface CreatePageProps {
  /** 不传 = 从 `?recordId=` 读（真实路由走这条） */
  recordId?: string;
  catalog?: AICatalog;
  priceTable?: PriceTable;
  spent?: number;
  budgetLimit?: number | null;
  onSpend?: (amount: number) => void;
  /** 注入生图适配器（测试 / 宿主托管时用） */
  imageAdapter?: ImageAdapter;
  /** 注入文字生成（测试里给假模型响应） */
  generateText?: TextGenerator;
  /** 注入追问生成（M5a3；测试里断言走的是 chat 而不是 pack） */
  generateFollowUp?: FollowUpGenerator;
  /** 会话上下文窗口（模型表没有这个字段；默认 128k，测试里可以设小值验 60% 阈值） */
  contextWindow?: number;
  now?: () => number;
}

interface LoadedState {
  catalog: AICatalog;
  priceTable: PriceTable;
  budgetLimit: number | null;
  spent: number;
}

const EMPTY_CATALOG: AICatalog = { providers: [], updatedAt: 0 };

/**
 * 生成请求的超时（M5a3）。
 *
 * 客户端默认 20s 是给「自检/探活」那类一次问答用的；而首轮 pack 要让模型吐一整套 JSON
 * （实测免费档 glm-4.x-flash 生成 800+ token 时直接超过 20s → 首轮永远失败），
 * 追问也要写几百字。所以生成这两条路径显式放宽到 90s —— 仍然是有限的超时，不是无限等。
 */
const GENERATE_TIMEOUT_MS = 90_000;

function modelKey(model: Pick<VideoModelRef, 'providerId' | 'modelId'>): string {
  return `${model.providerId}::${model.modelId}`;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '') ?? '';
  return line.trim().slice(0, 40);
}

export function CreatePage({
  recordId: recordIdProp,
  catalog: catalogProp,
  priceTable,
  spent,
  budgetLimit,
  onSpend,
  imageAdapter,
  generateText: generateTextProp,
  generateFollowUp: generateFollowUpProp,
  contextWindow,
  now,
}: CreatePageProps) {
  const [searchParams] = useSearchParams();
  const recordId = recordIdProp ?? searchParams.get('recordId') ?? undefined;

  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [recordText, setRecordText] = useState('');
  const [recordTime, setRecordTime] = useState<number | null>(null);
  const [tab, setTab] = useState<CreateTabId>('dream');
  const [textModelKey, setTextModelKey] = useState('');
  const [imageModelKey, setImageModelKey] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageCount, setImageCount] = useState(1);
  const [aspect, setAspect] = useState<ImageAspect>('1:1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Array<{ code: string; message: string; where?: string }>>([]);
  const [rawOutput, setRawOutput] = useState('');
  const [spentValue, setSpentValue] = useState(spent ?? 0);
  const [confirmPending, setConfirmPending] = useState(false);
  /**
   * 副本快照版本号：`loadBrowserPack` 是同步函数，快照在 IndexedDB 里要先读进内存。
   * 读完后 +1，让依赖 pack 正文的估算（`threadSystemText`）重算。
   */
  const [promptRev, setPromptRev] = useState(0);

  /* ---- M5a3：会话 ---- */
  const [thread, setThread] = useState<Thread | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  /** 本轮已「存为产物」的自由文本轮下标（只影响按钮文案） */
  const [savedTurns, setSavedTurns] = useState<Set<number>>(new Set());
  /**
   * 生成序号：点「停止」就 +1。迟到回来的结果看到序号变了就**直接丢弃**，
   * 不写 turn、不记账 —— 这是"停止"能真的不落库的唯一机制。
   */
  const runSeq = useRef(0);
  const nowFn = useCallback(() => (now ?? Date.now)(), [now]);

  const artifacts = useRecordArtifacts(recordId);

  /* 读配置（只读"没被 props 注入"的那几项，测试因此可以完全离线） */
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const [catalogFromStore, table, aiConfig, spendState] = await Promise.all([
        catalogProp === undefined ? loadCatalog() : Promise.resolve(null),
        priceTable === undefined ? loadPriceTable() : Promise.resolve(null),
        budgetLimit === undefined ? loadAIConfig() : Promise.resolve(null),
        spent === undefined ? loadSpend() : Promise.resolve(null),
      ]);
      // 自定义提示词副本：读进内存快照后 `loadBrowserPack` 才能同步解析到它
      await hydrateCustomPrompts();
      if (cancelled) return;
      setPromptRev((value) => value + 1);
      setLoaded({
        catalog: catalogProp ?? catalogFromStore ?? EMPTY_CATALOG,
        priceTable: priceTable ?? table ?? OFFICIAL_PRICE_TABLE,
        budgetLimit: budgetLimit !== undefined ? budgetLimit : aiConfig?.budgetLimit ?? null,
        spent: spent ?? spendState?.spent ?? 0,
      });
      if (spent !== undefined) setSpentValue(spent);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [catalogProp, priceTable, budgetLimit, spent]);

  /* 记录正文 */
  useEffect(() => {
    let cancelled = false;
    if (!recordId) return;
    const run = async () => {
      try {
        const entity = await getRecordEntity(recordId);
        if (cancelled) return;
        if (!entity) {
          setError('这条记录不存在或已被删除');
          return;
        }
        setRecordText(entity.text);
        setRecordTime(entity.createdAt);
        if (entity.text.trim() !== '') setImagePrompt(entity.text.trim().slice(0, 200));
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  const textModels = useMemo(
    () => (loaded ? listModelsByCap(loaded.catalog, 'text') : []),
    [loaded],
  );

  /* 会话线程：换记录 / 换 tab（解梦↔灵感）都重新读一遍；生图/生视频没有会话 */
  useEffect(() => {
    let cancelled = false;
    const kind = tab === 'dream' || tab === 'copy' ? (tab as ThreadKind) : null;
    if (!recordId || kind === null) {
      setThread(null);
      setThreads([]);
      return;
    }
    const run = async () => {
      try {
        const list = await listThreadsByKind(recordId, kind);
        if (cancelled) return;
        setThreads(list);
        setThread(list[0] ?? null);
        setSavedTurns(new Set());
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [recordId, tab]);
  const imageModels = useMemo(
    () => (loaded ? listModelsByCap(loaded.catalog, 'image') : []),
    [loaded],
  );
  const videoModels = useMemo(
    () => (loaded ? listModelsByCap(loaded.catalog, 'video') : []),
    [loaded],
  );

  /* 默认模型 = pickModel(cap)（UI-SKELETON §2：唯一入口是选择器，默认值按能力挑） */
  useEffect(() => {
    if (!loaded) return;
    if (textModelKey === '') {
      const picked = pickModel(loaded.catalog, 'text');
      if (picked.ok && picked.provider && picked.model) {
        setTextModelKey(`${picked.provider.id}::${picked.model.modelId}`);
      }
    }
    if (imageModelKey === '') {
      const picked = pickModel(loaded.catalog, 'image');
      if (picked.ok && picked.provider && picked.model) {
        setImageModelKey(`${picked.provider.id}::${picked.model.modelId}`);
      }
    }
  }, [loaded, textModelKey, imageModelKey]);

  const currentTextModel =
    textModels.find((model) => modelKey(model) === textModelKey) ?? textModels[0];
  const currentImageModel =
    imageModels.find((model) => modelKey(model) === imageModelKey) ?? imageModels[0];

  /* 生图适配器（注入优先；否则按模型所属连接装配） */
  const imageWiring = useMemo(() => {
    if (!loaded || !currentImageModel) return null;
    if (imageAdapter) {
      const price = imagePriceFor(currentImageModel.modelId, loaded.priceTable);
      return { ok: true as const, adapter: imageAdapter, free: price.free, priceRow: price.row };
    }
    const connection = activeConnectionFor(loaded.catalog, currentImageModel.providerId);
    const result = adapterForModel({
      modelId: currentImageModel.modelId,
      baseUrl: connection?.baseUrl ?? '',
      apiKey: connection?.apiKey ?? '',
    });
    if (!result.ok) return result;
    return { ok: true as const, adapter: result.adapter, free: result.free, priceRow: result.priceRow };
  }, [loaded, currentImageModel, imageAdapter]);

  const handleSpend = useCallback(
    async (amount: number) => {
      if (amount <= 0) return;
      onSpend?.(amount);
      const next = await recordSpend(amount);
      setSpentValue(next.spent);
    },
    [onSpend],
  );

  /* ---------------------------------------------------------------- */
  /* 文字生成（解梦 / 文案）                                            */
  /* ---------------------------------------------------------------- */

  const defaultGenerateText = useCallback<TextGenerator>(
    async (prompt) => {
      if (!currentTextModel) throw new Error(capHint('text'));
      const connection = activeConnectionFor(loaded?.catalog ?? EMPTY_CATALOG, currentTextModel.providerId);
      if (!connection) throw new Error('这个模型所属的连接找不到了：去 AI 配置确认一下');
      const response = await chat(
        {
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          model: currentTextModel.modelId,
          protocol: connection.protocol,
          timeoutMs: GENERATE_TIMEOUT_MS,
        },
        {
          model: currentTextModel.modelId,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          max_tokens: 2000,
        },
      );
      if (!response.success) throw new Error(response.error.userMessage);
      // M3R11 §3：方舟的 model id 是版本化的（…-260628），价格表按族名记 → 先归一
      const priceRow =
        loaded?.priceTable.text[
          priceKeyForTextModel(currentTextModel.modelId, loaded.priceTable)
        ] ?? null;
      // 实际用量 × 单价：拿不到 usage 或单价未录入就记 0（不编一个数当账单）
      const cost =
        priceRow && response.usage
          ? (response.usage.prompt_tokens / 1e6) * (priceRow.inputPerMTokens ?? 0) +
            (response.usage.completion_tokens / 1e6) * (priceRow.outputPerMTokens ?? 0)
          : 0;
      return { text: response.content, cost };
    },
    [currentTextModel, loaded],
  );

  /**
   * 追问的默认实现（M5a3 §2）：**直接发 chat**，不拼 pack 的 JSON 指令、不过校验器。
   * messages = system + 本线程全部有效轮（`toChatMessages` 已滤掉失败轮）。
   */
  const defaultGenerateFollowUp = useCallback<FollowUpGenerator>(
    async (prompt) => {
      if (!currentTextModel) throw new Error(capHint('text'));
      const connection = activeConnectionFor(
        loaded?.catalog ?? EMPTY_CATALOG,
        currentTextModel.providerId,
      );
      if (!connection) throw new Error('这个模型所属的连接找不到了：去 AI 配置确认一下');
      const response = await chat(
        {
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          model: currentTextModel.modelId,
          protocol: connection.protocol,
          timeoutMs: GENERATE_TIMEOUT_MS,
        },
        {
          model: currentTextModel.modelId,
          messages: [{ role: 'system', content: prompt.system }, ...prompt.messages],
          max_tokens: 1200,
        },
      );
      if (!response.success) throw new Error(response.error.userMessage);
      const priceRow =
        loaded?.priceTable.text[
          priceKeyForTextModel(currentTextModel.modelId, loaded.priceTable)
        ] ?? null;
      const cost =
        priceRow && response.usage
          ? (response.usage.prompt_tokens / 1e6) * (priceRow.inputPerMTokens ?? 0) +
            (response.usage.completion_tokens / 1e6) * (priceRow.outputPerMTokens ?? 0)
          : 0;
      return { text: response.content, cost, tokens: response.usage?.total_tokens };
    },
    [currentTextModel, loaded],
  );

  const priceRowForText = useMemo(() => {
    if (!loaded || !currentTextModel) return null;
    // 同上：版本化 id → 价格表族名（M3R11 §3）
    return (
      loaded.priceTable.text[priceKeyForTextModel(currentTextModel.modelId, loaded.priceTable)] ??
      null
    );
  }, [loaded, currentTextModel]);

  /** 文字 tab 的预估：只算输入（输出长度不可知），并明确标「估算」 */
  const textEstimate = useMemo(() => {
    // 记录正文 + pack 提示词体量（system 正文 + 校验清单，按经验给 1200 字符）+ 会话里已有的轮
    const threadChars = thread
      ? thread.turns.reduce((sum, turn) => sum + turn.content.length, 0)
      : 0;
    const chars = recordText.length + 1200 + threadChars;
    return estimateText({ inputChars: chars, outputChars: 0, priceRow: priceRowForText });
  }, [recordText, priceRowForText, thread]);

  /** 生图预估：按张计费；单价未录入 → 返回 null（UI 显示"未核实"，不编金额） */
  const imageEstimate = useMemo(() => {
    if (!imageWiring?.ok) return null;
    if (!imageWiring.priceRow || imageWiring.priceRow.perImage === null) return null;
    return estimateImage({ count: imageCount, priceRow: imageWiring.priceRow });
  }, [imageWiring, imageCount]);

  const activeEstimate = tab === 'image' ? imageEstimate?.total ?? 0 : textEstimate.total;
  const budget = loaded?.budgetLimit ?? null;
  const verdict = useMemo(
    () => checkBudget({ estimate: activeEstimate, spent: spentValue, budget }),
    [activeEstimate, spentValue, budget],
  );

  /* 换 tab / 换模型 / 改张数后重新确认（避免"确认过一次就一直放行"） */
  useEffect(() => {
    setConfirmPending(false);
  }, [tab, imageCount, textModelKey, imageModelKey]);

  /* ---------------------------------------------------------------- */
  /* 会话上下文预算（M5a3 §4）：全部是**估算**，界面上必须写「≈」       */
  /* ---------------------------------------------------------------- */

  const threadPackId = thread?.packId;
  const threadTurns = useMemo(() => contextTurns(thread?.turns ?? []), [thread]);
  /** 追问时真正发出去的 system：pack 提示词 + 记录正文（见 buildFollowUpSystemPrompt） */
  const threadSystemText = useMemo(() => {
    if (threadPackId === undefined) return '';
    try {
      return buildFollowUpSystemPrompt(loadBrowserPack(threadPackId), recordText);
    } catch {
      // pack 名对不上（未来换了 pack 名）：只按记录正文估，不假装有 system
      return recordText;
    }
  }, [threadPackId, recordText, promptRev]);
  const threadTokens = useMemo(
    () => estimateConversationTokens(threadSystemText, threadTurns),
    [threadSystemText, threadTurns],
  );
  /**
   * 窗口从哪来：调用方传的 `contextWindow` 优先（测试/嵌入用），
   * 否则用**当前文本模型自己声明的上下文**（配置页模型行的「1M」勾选），
   * 都没有才回落到 128k。模型支持 1M 但没勾，就只按 128k 估。
   */
  const contextState = useMemo(
    () =>
      contextBudget(
        threadTokens,
        contextWindow ??
          (currentTextModel?.contextSource === 'none'
            ? Number.POSITIVE_INFINITY
            : currentTextModel?.contextLength ?? DEFAULT_CONTEXT_WINDOW),
      ),
    [threadTokens, contextWindow, currentTextModel?.contextLength, currentTextModel?.contextSource],
  );

  /* ---------------------------------------------------------------- */
  /* 会话编排（M5a3）                                                   */
  /* 首轮 = runPackInBrowser（结构化 + 校验器）；追问 = chat（自由文本）  */
  /* ---------------------------------------------------------------- */

  type TurnOutcome =
    | { ok: true; content: string; structured?: unknown; tokens?: number; cost: number }
    | { ok: false; error: string };

  const errorText = (caught: unknown): string =>
    caught instanceof Error ? caught.message : String(caught);

  /** 首轮：跑 pack。`saveArtifactToo` 只在"这次真的产出了结构化结果"时为 true */
  const runFirstTurn = async (target: Thread, saveArtifactToo: boolean): Promise<TurnOutcome> => {
    try {
      const pack = loadBrowserPack(target.packId);
      const input =
        target.kind === 'dream' ? { dream_text: recordText } : { record_text: recordText };
      const generate = generateTextProp ?? defaultGenerateText;
      let costOfRun = 0;
      const result = await runPackInBrowser(pack, input, async (prompt) => {
        const output = await generate(prompt);
        if (typeof output === 'string') return output;
        costOfRun = output.cost ?? 0;
        return output.text;
      });

      setRawOutput(result.raw);
      setIssues(result.issues);

      // 只有过了校验器才算一轮成功的首轮；不合格的输出不落成产物、也不当历史
      if (result.issues.length > 0 || result.output === null) {
        return {
          ok: false,
          error: `模型输出不合格（${result.issues.length} 项），见下方问题清单`,
        };
      }
      if (saveArtifactToo) {
        await saveArtifact({
          recordId: target.recordId,
          kind: target.kind === 'dream' ? 'dream' : 'copy',
          payload: result.output,
          modelId: currentTextModel?.modelId ?? 'unknown',
          cost: costOfRun,
        });
        artifacts.reload();
      }
      return {
        ok: true,
        content: structuredToText(result.output, target.kind as ThreadKind),
        structured: result.output,
        cost: costOfRun,
      };
    } catch (caught) {
      return { ok: false, error: errorText(caught) };
    }
  };

  /** 追问：直接 chat，自由文本。失败返回 error（由调用方写成一条"标错的 turn"） */
  const runChatTurn = async (target: Thread, history: Turn[]): Promise<TurnOutcome> => {
    try {
      const pack = loadBrowserPack(target.packId);
      const generate = generateFollowUpProp ?? defaultGenerateFollowUp;
      const output = await generate({
        system: buildFollowUpSystemPrompt(pack, recordText),
        messages: toChatMessages(history),
      });
      return {
        ok: true,
        content: output.text,
        tokens: output.tokens,
        cost: output.cost ?? 0,
      };
    } catch (caught) {
      return { ok: false, error: errorText(caught) };
    }
  };

  /** 写 turns（唯一写入口）：顺带把线程列表里的那条也换掉，切换器上的"几答"才不会滞后 */
  const persistTurns = async (target: Thread, turns: Turn[]): Promise<Thread | null> => {
    const next = await setThreadTurns(target.id, turns, nowFn);
    if (!next) return null;
    setThread((current) => (current !== null && current.id === next.id ? next : current));
    setThreads((list) =>
      list.map((item) => (item.id === next.id ? next : item)).sort((a, b) => b.updatedAt - a.updatedAt),
    );
    return next;
  };

  /** 把一次生成结果写成 turn：index < 0 = 追加；否则**原地替换**（重新生成/重试不新增轮次） */
  const applyOutcome = async (
    target: Thread,
    index: number,
    outcome: TurnOutcome,
  ): Promise<Thread | null> => {
    const at = nowFn();
    const turn: Turn = outcome.ok
      ? {
          role: 'assistant',
          content: outcome.content,
          at,
          ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
          ...(outcome.tokens !== undefined && outcome.tokens > 0 ? { tokens: outcome.tokens } : {}),
        }
      : { role: 'assistant', content: '', at, error: outcome.error };

    const turns =
      index < 0
        ? [...target.turns, turn]
        : target.turns.map((item, itemIndex) => (itemIndex === index ? turn : item));
    const saved = await persistTurns(target, turns);
    if (saved !== null && outcome.ok && outcome.cost > 0) await handleSpend(outcome.cost);
    return saved;
  };

  /** 首轮（点「生成解梦 / 生成灵感」或在空会话里点首轮按钮） */
  const startConversation = async (kind: ThreadKind, existing?: Thread) => {
    if (!recordId) return;
    if (verdict.requiresConfirm && !confirmPending) {
      setConfirmPending(true);
      return;
    }
    setError(null);
    setIssues([]);
    setRawOutput('');
    let target = existing;
    if (target === undefined) {
      target = await createThread({ recordId, kind, now: nowFn });
      setThread(target);
      setThreads((list) => [target as Thread, ...list]);
      setSavedTurns(new Set());
    }
    const myRun = (runSeq.current += 1);
    setBusy(true);
    try {
      const outcome = await runFirstTurn(target, true);
      if (runSeq.current !== myRun) return; // 停止 → 不写 turn
      await applyOutcome(target, -1, outcome);
    } finally {
      if (runSeq.current === myRun) setBusy(false);
    }
  };

  /** 追问：用户消息**先落库**（对话里它已经发生了），assistant 结果成功才写 */
  const sendFollowUp = async (text: string) => {
    if (!thread || text.trim() === '') return;
    const target = thread;
    setError(null);
    const userTurn: Turn = { role: 'user', content: text.trim(), at: nowFn() };
    const withUser = [...target.turns, userTurn];
    const persisted = await persistTurns(target, withUser);
    if (persisted === null) return;

    const myRun = (runSeq.current += 1);
    setBusy(true);
    try {
      const outcome = await runChatTurn(persisted, withUser);
      if (runSeq.current !== myRun) return; // 停止 → 丢弃，不写 turn
      await applyOutcome(persisted, -1, outcome);
    } finally {
      if (runSeq.current === myRun) setBusy(false);
    }
  };

  /** 重新生成 / 重试：**原地替换**那一轮（不新增轮次；停止则保留旧轮，不丢内容） */
  const regenerateTurn = async (index: number) => {
    if (!thread) return;
    const target = thread;
    const current = target.turns[index];
    if (!current || current.role !== 'assistant') return;
    const history = target.turns.slice(0, index);
    const myRun = (runSeq.current += 1);
    setBusy(true);
    try {
      // 首轮失败的轮重试时，这次成功了要补存产物；首轮成功的轮重新生成则不重复存
      const outcome =
        index === 0
          ? await runFirstTurn(target, current.error !== undefined)
          : await runChatTurn(target, history);
      if (runSeq.current !== myRun) return;
      await applyOutcome(target, index, outcome);
    } finally {
      if (runSeq.current === myRun) setBusy(false);
    }
  };

  const stopGeneration = () => {
    runSeq.current += 1; // 迟到的结果会看到序号变了 → 丢弃
    setBusy(false);
  };

  /** 把任意一轮 assistant 回答存成产物（首轮的结构化回答在生成时已存，这里是自由文本） */
  const saveTurnAsArtifact = async (index: number) => {
    if (!thread || !recordId) return;
    const turn = thread.turns[index];
    if (!turn || turn.role !== 'assistant' || turn.error !== undefined) return;
    if (turn.structured !== undefined) return; // 已随首轮存过，不重复
    try {
      await saveArtifact({
        recordId,
        kind: 'note',
        payload: { text: turn.content, threadId: thread.id, turnIndex: index },
        modelId: currentTextModel?.modelId ?? 'unknown',
        cost: 0,
      });
      artifacts.reload();
      setSavedTurns((current) => new Set(current).add(index));
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  /** 新会话：旧线程留着（可切换），新线程空着等首轮 */
  const newConversation = async () => {
    if (!thread || !recordId) return;
    if (thread.turns.length === 0) return; // 已经是空会话，别再开一条
    runSeq.current += 1;
    setBusy(false);
    setIssues([]);
    setRawOutput('');
    const created = await createThread({ recordId, kind: thread.kind as ThreadKind, now: nowFn });
    setThread(created);
    setThreads((list) => [created, ...list]);
    setSavedTurns(new Set());
  };

  const switchThread = (threadId: string) => {
    const target = threads.find((item) => item.id === threadId);
    if (!target) return;
    // 切会话 = 放弃进行中的生成（否则结果会写进"看不见的那条"）
    runSeq.current += 1;
    setBusy(false);
    setThread(target);
    setSavedTurns(new Set());
  };

  /* ---------------------------------------------------------------- */
  /* 生图                                                              */
  /* ---------------------------------------------------------------- */

  const runImage = async () => {
    if (!recordId || !imageWiring?.ok || !currentImageModel) return;
    if (imagePrompt.trim() === '') {
      setError('提示词是空的：生图接口只认 prompt');
      return;
    }
    if (verdict.requiresConfirm && !confirmPending) {
      setConfirmPending(true);
      return;
    }
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      const adapter = imageWiring.adapter;
      const result = await adapter.generate({
        prompt: imagePrompt.trim(),
        model: currentImageModel.modelId,
        count: imageCount,
        aspect,
      });

      const perImage = imageWiring.priceRow?.perImage ?? 0;
      const stamp = (now ?? Date.now)();

      for (const [index, image] of result.images.entries()) {
        const key = `img_${stamp}_${index}`;
        let blobUrl: string | null = null;
        let remoteUrl = '';

        if (image.url) {
          remoteUrl = image.url;
          blobUrl = await adapter.downloadAndStore(image.url, key);
        } else if (image.b64) {
          if (adapter instanceof AbstractImageAdapter) {
            blobUrl = await adapter.storeBase64(image.b64, key);
          } else {
            setError('适配器只回了 base64，但注入的实现不支持落盘：换一个适配器或让它实现 storeBase64');
            continue;
          }
        } else {
          continue;
        }

        // 从库里读回真实的类型/体积（downloadAndStore 只回地址）
        const stored = blobUrl ? await getStoredImage(imageBlobId(key)) : undefined;
        await saveArtifact({
          id: key,
          recordId,
          kind: 'image',
          modelId: currentImageModel.modelId,
          cost: perImage,
          now: () => stamp,
          payload: {
            prompt: imagePrompt.trim(),
            remoteUrl,
            blobId: imageBlobId(key),
            mimeType: stored?.mimeType ?? 'image/png',
            size: stored?.blob.size ?? 0,
            expiresAt: stamp + adapter.urlTtl.ms,
            ttlVerified: adapter.urlTtl.verified,
            ttlNote: adapter.urlTtl.note,
            imageSize: result.size,
          },
        });
        await handleSpend(perImage);
      }
      artifacts.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /* 渲染                                                              */
  /* ---------------------------------------------------------------- */

  const capabilityHint = (cap: ModelCap): string => capHint(cap);

  const renderModelSelect = (
    label: string,
    models: VideoModelRef[],
    current: VideoModelRef | undefined,
    onChange: (key: string) => void,
  ) => (
    <label className="field create-model">
      <span>{label}</span>
      <select
        aria-label={label}
        value={current ? modelKey(current) : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)}>
            {model.displayName || model.modelId}（{model.providerName}）
          </option>
        ))}
      </select>
    </label>
  );

  const costLine = (() => {
    if (tab === 'image') {
      if (!imageWiring?.ok) return null;
      if (imageWiring.free) return '免费（官方免费档）';
      if (!imageEstimate) return '单价未核实（未计入预算）';
      return `预计 ${formatYuan(imageEstimate.total)}`;
    }
    if (textEstimate.error || !priceRowForText) {
      return '单价未录入（按实际结算）';
    }
    // 极小的估算额不要显示成 ¥0.00（那看起来像"不花钱"）
    if (textEstimate.total === 0) return '免费';
    if (textEstimate.total < 0.01) return '预计 <¥0.01（仅估输入）';
    return `预计 ${formatYuan(textEstimate.total)}（仅估输入）`;
  })();

  const generateButtonLabel = (() => {
    if (verdict.requiresConfirm) {
      if (confirmPending) return '确认生成（这次会超出预算）';
      return tab === 'image' ? '超出预算 · 仍需生成图片' : '超出预算 · 仍需生成';
    }
    if (busy) return '生成中…';
    if (tab === 'image') return '生成图片';
    return tab === 'dream' ? '生成解梦' : '生成灵感';
  })();

  const panelHint = (cap: ModelCap, models: VideoModelRef[]) =>
    models.length === 0 ? (
      <section className="card">
        <p className="warn-inline" data-testid="create-missing-cap">
          {capabilityHint(cap)}
        </p>
        <p className="muted small">
          <Link className="muted guide-link" to="/ai-config">
            去 AI 配置
          </Link>
          {' '}（点带对应能力标签的预设；配好后回到这一页）
        </p>
      </section>
    ) : null;

  const activeTab = CREATE_TABS.find((item) => item.id === tab) ?? CREATE_TABS[0];

  return (
    <section className="page create-page">
      <div className="page-header create-page-header">
        <h2>创作</h2>
        <Link to={recordId ? `/records/${recordId}` : '/'} className="button ghost">
          ← 返回记录
        </Link>
      </div>

      <p className="muted small create-record-summary">
        {recordId ? (
          <>
            {firstLine(recordText) || '（无文字，仅录音）'}
            {recordTime !== null ? ` · ${new Date(recordTime).toLocaleString()}` : ''}
          </>
        ) : (
          <>
            没有指定记录：
            <Link to="/create">回创作入口选一条</Link>
          </>
        )}
      </p>

      <div className="create-tabs" role="tablist" aria-label="创作能力">
        {CREATE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'create-tab active' : 'create-tab'}
            data-testid={`create-tab-${item.id}`}
            disabled={item.disabled === true}
            title={item.disabled ? '音频生成还没接进来：现在只支持在 AI 配置里登记音频模型' : undefined}
            onClick={() => {
              if (item.disabled) return;
              setTab(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card create-panel" role="tabpanel" aria-label={activeTab.label}>
        {!loaded ? (
          <p className="muted small">正在读取模型表…</p>
        ) : tab === 'dream' || tab === 'copy' ? (
          textModels.length === 0 ? (
            panelHint('text', textModels)
          ) : (
            <>
              {renderModelSelect('文本模型', textModels, currentTextModel, setTextModelKey)}
              <p className="muted small">
                {tab === 'dream'
                  ? '用记录正文当梦境原文，首轮输出「整体解读 + 意象清单 + 免责声明」（不合格会列出问题，不会静默丢弃）；之后可以接着追问。'
                  : '从这条记录衍生 3 个彼此不同的故事方向；首轮是结构化卡片，之后可以接着追问。'}
              </p>
              {thread ? (
                <ThreadView
                  thread={thread}
                  threads={threads}
                  busy={busy}
                  budget={contextState}
                  costLine={costLine}
                  disabledReason={
                    recordText.trim() === '' ? '这条记录没有正文：解梦/灵感需要文字' : null
                  }
                  savedTurns={savedTurns}
                  onSend={(text) => void sendFollowUp(text)}
                  onStop={stopGeneration}
                  onRegenerate={(index) => void regenerateTurn(index)}
                  onRetry={(index) => void regenerateTurn(index)}
                  onSaveArtifact={(index) => void saveTurnAsArtifact(index)}
                  onNewThread={() => void newConversation()}
                  onSwitchThread={switchThread}
                  onStartFirst={() => void startConversation(thread.kind as ThreadKind, thread)}
                  firstTurnLabel={generateButtonLabel}
                  firstTurnCostLine={costLine}
                />
              ) : (
                <div className="create-actions">
                  <button
                    type="button"
                    className="button primary"
                    data-testid="create-start"
                    disabled={busy || recordText.trim() === ''}
                    onClick={() => void startConversation(tab as ThreadKind)}
                  >
                    {generateButtonLabel}
                  </button>
                  {costLine && <span className="muted small create-cost">{costLine}</span>}
                </div>
              )}
              {verdict.requiresConfirm && (
                <p className="warn-inline">{verdict.message ?? '这次会超出预算，请再点一次确认'}</p>
              )}
            </>
          )
        ) : tab === 'image' ? (
          imageModels.length === 0 ? (
            panelHint('image', imageModels)
          ) : (
            <>
              {renderModelSelect('生图模型', imageModels, currentImageModel, setImageModelKey)}
              <label className="field">
                <span>提示词</span>
                <textarea
                  aria-label="生图提示词"
                  rows={3}
                  value={imagePrompt}
                  onChange={(event) => setImagePrompt(event.target.value)}
                />
              </label>
              <div className="create-row">
                <label className="field">
                  <span>比例</span>
                  <select
                    aria-label="图片比例"
                    value={aspect}
                    onChange={(event) => setAspect(event.target.value as ImageAspect)}
                  >
                    <option value="1:1">1:1</option>
                    <option value="3:4">3:4</option>
                    <option value="4:3">4:3</option>
                    <option value="16:9">16:9</option>
                    <option value="9:16">9:16</option>
                  </select>
                </label>
                <label className="field">
                  <span>张数</span>
                  <select
                    aria-label="生成张数"
                    value={imageCount}
                    onChange={(event) => setImageCount(Number(event.target.value))}
                  >
                    {Array.from({ length: MAX_IMAGE_COUNT }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {imageCount > 1 && (
                <p className="muted small">
                  官方接口没有批量参数：{imageCount} 张 = 发 {imageCount} 次单张请求，按 {imageCount} 次计费。
                </p>
              )}
              {imageWiring && !imageWiring.ok && (
                <p className="warn-inline">
                  {imageWiring.reason}
                  {imageWiring.hint ? ` ${imageWiring.hint}` : ''}
                </p>
              )}
              <div className="create-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !imageWiring?.ok}
                  onClick={() => void runImage()}
                >
                  {generateButtonLabel}
                </button>
                {costLine && <span className="muted small create-cost">{costLine}</span>}
              </div>
              {imageWiring?.ok && (
                <p className="muted small">远端地址时效：{imageWiring.adapter.urlTtl.note}</p>
              )}
              {verdict.requiresConfirm && (
                <p className="warn-inline">{verdict.message ?? '这次会超出预算，请再点一次确认'}</p>
              )}
            </>
          )
        ) : tab === 'audio' ? (
          /* R7a：只做说明，**不给生成按钮**（生成链路没接，假按钮比没有更糟） */
          <section className="card" data-testid="create-audio-coming">
            <h4>音频生成 · 即将支持</h4>
            <p className="muted small">
              这一版只支持在 AI 配置里登记音频模型（能力标签「音频」，例如 MiniMax 的 speech-2.8-hd）：
              能配置、能看、能指定给「音频」角色。真正的合成（配音 / 音乐）还没接进来，所以这里不做按钮，
              免得点了没反应。
            </p>
            <p className="muted small">
              语音识别（把录音转成文字）走的是设置页的「语音识别」通道，与这里无关。
              {' '}
              <Link className="muted guide-link" to="/ai-config">
                去 AI 配置
              </Link>
            </p>
          </section>
        ) : videoModels.length === 0 ? (
          panelHint('video', videoModels)
        ) : (
          /*
            P2：生视频就地出面板（原独立视频页的正文），不再跳到别的路由。
            catalog / priceTable / spent / budgetLimit 由本页传入 —— 它已经读过配置，
            这一块不必再读一遍 IndexedDB。
          */
          <VideoGenerationSection
            catalog={loaded.catalog}
            priceTable={loaded.priceTable}
            spent={spentValue}
            budgetLimit={loaded.budgetLimit}
            onSpend={(amount) => void handleSpend(amount)}
          />
        )}
      </div>

      {issues.length > 0 && (
        <section className="card create-issues" data-testid="create-issues">
          <h3>模型输出不合格（{issues.length} 项）</h3>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <code>{issue.code}</code>
                {issue.where ? ` @ ${issue.where}` : ''}：{issue.message}
              </li>
            ))}
          </ul>
          {rawOutput !== '' && (
            <details>
              <summary className="muted small">看模型原文</summary>
              <pre className="create-raw">{rawOutput}</pre>
            </details>
          )}
        </section>
      )}

      <section className="card create-artifacts">
        <h3>这条记录的产物</h3>
        {artifacts.loading && <p className="muted small">正在读取…</p>}
        {artifacts.error && <p className="error">{artifacts.error}</p>}
        {!artifacts.loading && artifacts.items.length === 0 && (
          <p className="muted small">还没有产物：在上面选一个 tab 生成。</p>
        )}
        <div className="artifact-list">
          {artifacts.items.map((item: ArtifactItem) => (
            <ArtifactCard key={item.id} item={item} />
          ))}
        </div>
      </section>
    </section>
  );
}

/**
 * `/create` 的分流器（P2 §1）。
 *
 * - 带 `?recordId=` → 直达单卡创作（`RecordDetailPage` 的「进入创作」走这条，深链不许坏）；
 * - 不带 → 创作入口页（`CreateHub`，三块磁贴）。
 *
 * 为什么不在 `CreatePage` 里写 `if (!recordId) return <CreateHub/>`：
 * 那会让「有/无 recordId」两种形态共用同一个组件的 hooks 顺序，且入口页一旦改动就动到
 * 单卡创作这个已经稳定的页面。分流器只做一件事：读参数、选组件。
 */
export function CreateRoute() {
  const [searchParams] = useSearchParams();
  const recordId = searchParams.get('recordId');
  if (recordId === null || recordId === '') return <CreateHub />;
  return <CreatePage recordId={recordId} />;
}
