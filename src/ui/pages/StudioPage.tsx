/**
 * 写作工作台（P3 建立 / P4 重做布局）。
 *
 * 委托人的原话：「展示区、写作区，也包括素材区与 AI 区应该要能支持大小调整甚至隐藏」、
 * 「展示区不一定要留 3 个位置，只展示一个素材时考虑占满整个素材区」、
 * 「把素材拖拽进展示区」、「没有可用文本模型时……要做的不是启用按钮，而是引导用户配置模型」。
 *
 * 三栏各管一件事（P4 起四块可调可折叠）：
 * 1. **左**：全部记录（最近 200 条），带搜索（300ms 防抖）与合集筛选（复用 P2b 的 `library`）。
 *    **点一下勾选**和**拖进展示区**两条路都通，都走同一个 `addMaterial()`（上限只在那里判一次）。
 * 2. **中**：展示区（按选中数量自适应：0 引导 / 1 占满 / 2 并排 / 3+ 网格）+ 正文（textarea）。
 *    正文**自动保存**到 `settings.studio-draft`（500ms 防抖），状态栏如实显示保存状态。
 * 3. **右**：AI 对话。每条用户消息上方有「📎 N 条素材 · 正文 M 字」徽标，点开是**实际发出去的**
 *    那串字符（`core/studio/context` 的产物，不是另拼一份摘要）。模型可在右上换
 *    （存 `settings.studio-model`），回复下方三个落笔动作：替换（二次确认）/ 插入光标处 / 追加末尾。
 *    **普通对话不改正文**——只有点这三个按钮之一才动。
 *
 * 布局状态（P4）：栏宽 + 三块折叠状态存 `settings.studio-layout`，重挂载恢复；
 * 拖拽用原生 pointer 事件 + `setPointerCapture`（不引入任何拖拽库）。
 * **折叠是 CSS + `hidden`，内容仍挂在 DOM 里** —— 搜索词、滚动位置、AI 对话不该被一次折叠清空。
 *
 * 生命周期（继承 canvas-teardown 的教训）：所有跨 tick 的异步写回都先看 `aliveRef`，
 * 卸载后既不 setState 也不 setError，否则测试环境拆掉之后会变成 unhandled rejection。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  activeConnectionFor,
  capHint,
  loadCatalog,
} from '../../adapters/ai-models/catalog';
import type { AICatalog, PickModelResult } from '../../adapters/ai-models/catalog';
import { chat } from '../../adapters/ai-models/client';
import { emptyLibrary, findCollection, loadLibrary } from '../../core/library';
import type { Library } from '../../core/library';
import {
  countRecordsByRole,
  createRecord,
  duplicateRecord,
  listRecords,
  listRecordsByIds,
  listRecordsInOrder,
  updateRecord,
} from '../../core/records';
import { isAssetRole, isCopyLike, normalizeRole } from '../../core/records/meta';
import type { RecordRoleCounts } from '../../core/records';
import type { RecordSummary } from '../../core/records/types';
import {
  STUDIO_SYSTEM_PROMPT,
  buildStudioUserMessage,
  contextHint,
} from '../../core/studio/context';
import {
  AUTOSAVE_DELAY_MS,
  MATERIAL_PAGE_SIZE,
  MAX_MATERIALS,
  countBodyChars,
  fingerprintDraft,
  loadDraft,
  moveMaterialId,
  pruneDraftMaterials,
  saveDraft,
} from '../../core/studio/draft';
import {
  COLLAPSED_WIDTH,
  DEFAULT_STUDIO_LAYOUT,
  MIN_DISPLAY_HEIGHT,
  clampLayout,
  collapseAll,
  expandAll,
  fitDisplayHeight,
  isAllCollapsed,
  loadLayout,
  resizeDisplayHeight,
  resizeLeft,
  resizeRight,
  saveLayout,
} from '../../core/studio/layout';
import type { StudioLayout } from '../../core/studio/layout';
import {
  MODEL_NOT_CONFIGURED,
  loadModelChoice,
  resolveStudioModel,
  saveModelChoice,
  studioModelOptions,
} from '../../core/studio/model-choice';
import type { StudioModelChoice, StudioModelOption } from '../../core/studio/model-choice';
import { describeError, formatDateTime } from '../format';

/** 一次 AI 请求的两个字段：system 是角色约束，user = 上下文 + 用户指令 */
export interface StudioAIPrompt {
  system: string;
  user: string;
}

/** 测试注入：默认实现走 `chat()`，注入时不许真的发请求（CHARTER §13.2） */
export type StudioGenerator = (prompt: StudioAIPrompt) => Promise<string>;

export interface StudioPageProps {
  /** 注入的 AI 生成实现（测试用） */
  generate?: StudioGenerator;
  /** 注入的模型目录（测试用；不传则从 settings 读） */
  catalog?: AICatalog;
}

export interface StudioMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
  /**
   * 这条用户消息**实际发出去**的完整字符串（徽标展开看到的就是它）。
   * 只有 user 消息有；AI 回复没有。
   */
  context?: string;
  /** 发出去时带了几条素材（徽标上的 N） */
  contextMaterials?: number;
  /** 发出去时正文多少字（徽标上的 M） */
  contextChars?: number;
}

/** 生成类请求的超时：与创作页同口径（默认 20s 对写几百字太短） */
const GENERATE_TIMEOUT_MS = 90_000;

/** 拖拽素材用的自定义类型（`text/plain` 也一起放，方便拖到别的应用里） */
const STUDIO_DRAG_TYPE = 'application/x-studio-material';
/**
 * 展示区内部换序用的类型（P4c §6.2）。**必须与上面那个不同**：展示区同时是
 * 「从左栏拖进来」的 drop 区，两种 drop 共用一个 zone，只能靠类型区分意图。
 */
const STUDIO_REORDER_TYPE = 'application/x-studio-reorder';

/** 下拉菜单离视口右边缘的最小留白（`right` 坐标最小 8px，别贴屏幕边） */
const MENU_EDGE_GAP = 8;


/** 「展示区」的布局档位：0 / 1 / 2 / many（3 条及以上走网格） */
type DisplayCount = '0' | '1' | '2' | 'many';

/** 素材条的元信息：`#梦 · 今天 12:03`（与样张一致，最多一个标签） */
function materialMeta(record: RecordSummary): string {
  const when = formatDateTime(record.createdAt);
  const tag = record.tags[0] ? `#${record.tags[0]}` : '';
  return tag ? `${tag} · ${when}` : when;
}

let messageSeq = 0;
function nextMessageId(): string {
  messageSeq += 1;
  return `msg_${Date.now().toString(36)}_${messageSeq}`;
}

function displayCountOf(count: number): DisplayCount {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count === 2) return '2';
  return 'many';
}

/**
 * 左侧素材区三段筛选（P5 §6）：全部 / 我写的 / AI 产出。
 *
 * **在内存里判**（不建索引、不升 Dexie 版本）：
 * - 我写的 = `note` 或 `draft`（自己敲的，包括写作台的成品）
 * - AI 产出 = `asset`
 */
type RoleFilter = 'all' | 'mine' | 'ai';

const ROLE_FILTERS: ReadonlyArray<{ key: RoleFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我写的' },
  { key: 'ai', label: 'AI 产出' },
];

function matchesRoleFilter(record: RecordSummary, filter: RoleFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ai') return isAssetRole(record.role);
  return !isAssetRole(record.role);
}

export function StudioPage({ generate, catalog: catalogProp }: StudioPageProps) {
  /* ---- 左：素材 ---- */
  const [records, setRecords] = useState<RecordSummary[] | null>(null);
  const [listTotal, setListTotal] = useState(0);
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  /** 防抖之后真正拿去查库的串 */
  const [search, setSearch] = useState('');
  /**
   * P5：左侧三段筛选（全部 / 我写的 / AI 产出）。**只影响渲染，不重查库** ——
   * role 不在索引里（见 core/records/meta.ts 顶部），筛在内存里做。
   */
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  /** 三段各自的条数（全库口径，`countRecordsByRole` 内存统计） */
  const [roleCounts, setRoleCounts] = useState<RecordRoleCounts | null>(null);
  /** 写库动作（存为记录 / 复制素材）之后 +1，用来重跑左栏与统计 */
  const [listVersion, setListVersion] = useState(0);
  /** 来源标题缓存：`sourceIds` → 那条记录的正文（详情/左栏的「来自「…」」） */
  const [sourceTitles, setSourceTitles] = useState<Map<string, string>>(new Map());

  /* ---- 中：展示区 + 正文 ---- */
  const [materials, setMaterials] = useState<RecordSummary[]>([]);
  const [body, setBody] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  /** 正在原地编辑原文的那张卡（P4c §2：按钮文案「编辑」，双击正文同样能进） */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  /**
   * P5「存为记录」：上次存成功时的指纹（来自草稿）。
   * 当前指纹 == 它 → 按钮是「已保存」禁用态；任何一处改动都会让两者不等。
   */
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [savingRecord, setSavingRecord] = useState(false);

  /* ---- 布局：栏宽 + 展示区高度 + 折叠（存 settings.studio-layout） ---- */
  const [layout, setLayout] = useState<StudioLayout>(DEFAULT_STUDIO_LAYOUT);
  const [layoutReady, setLayoutReady] = useState(false);
  const [draggingSide, setDraggingSide] = useState<'left' | 'right' | null>(null);
  /** 正在拖横向分隔条（展示区 / 正文之间） */
  const [draggingDisplay, setDraggingDisplay] = useState(false);
  /** 有素材正被拖到展示区上方（高亮边框用） */
  const [dropActive, setDropActive] = useState(false);
  /** 展示区卡片换序：正在拖的那张 / 落位提示挂在哪张卡的哪一侧（P4c §6.2） */
  const [reorder, setReorder] = useState<{ from: number; to: number; side: 'before' | 'after' } | null>(
    null,
  );

  /* ---- 右：AI ---- */
  const [catalog, setCatalog] = useState<AICatalog | null>(catalogProp ?? null);
  const [modelChoice, setModelChoice] = useState<StudioModelChoice | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  /** 键盘高亮到第几行（打开时=当前生效的模型，没有则 0）—— P4c §5 */
  const [modelActiveIndex, setModelActiveIndex] = useState(0);
  /**
   * 下拉菜单挂在 body 上的坐标（`position: fixed`）。
   * 为什么不在原地 `position:absolute`：`.studio-right` 有 `overflow: hidden`（折叠要用），
   * 菜单会被**祖先裁掉**；而且它要压过展示区。挂 body 两个问题一起没了（P4c §3.1）。
   */
  const [modelMenuBox, setModelMenuBox] = useState<{ right: number; top: number } | null>(null);
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  /** 点「替换正文」之后、真正覆盖之前的那一步（换 message.id） */
  const [confirmReplaceId, setConfirmReplaceId] = useState<string | null>(null);
  /** 徽标展开的那条消息（一次只展开一条） */
  const [openContextId, setOpenContextId] = useState<string | null>(null);

  /* ---- 通用 ---- */
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  /** 水合完成之前不写库（否则挂载瞬间会用空正文覆盖用户草稿） */
  const hydratedRef = useRef(false);
  /** 拖拽时同步读到最新布局（pointermove 里不等 re-render） */
  const layoutRef = useRef<StudioLayout>(DEFAULT_STUDIO_LAYOUT);
  /** 三栏外壳：算可用宽度、拖拽坐标都相对它 */
  const bodyElRef = useRef<HTMLDivElement | null>(null);
  /** 中栏：横向分隔条要按它的真实高度夹展示区高度 */
  const centerElRef = useRef<HTMLElement | null>(null);
  /** 外壳当前宽度（0 = 还没量到）。只用来**夹渲染结果**，不参与持久化 */
  const [containerWidth, setContainerWidth] = useState(0);
  /** 中栏当前高度（0 = 还没量到）；同样只夹渲染，不写回 */
  const [containerHeight, setContainerHeight] = useState(0);
  const bodyInputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 正文光标位置（`null` = 还没点过正文 → 插入动作落到末尾） */
  const caretRef = useRef<number | null>(null);
  /** 插入/追加之后要把光标放回哪（下次 body 更新后生效） */
  const pendingCaretRef = useRef<number | null>(null);
  /** 模型下拉：按钮（定位锚点）、菜单（点外部关闭要连它一起判） */
  const modelBtnRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuRef = useRef<HTMLUListElement | null>(null);
  /** 一次拖拽的起点快照 */
  const dragRef = useRef<{
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
    total: number;
  } | null>(null);
  /** 横向分隔条的一次拖拽（`startHeight` = 展示区高度，`available` = 中栏高度） */
  const heightDragRef = useRef<{ startY: number; startHeight: number; available: number } | null>(
    null,
  );

  /* ------------------------------------------------------------------ */
  /* 挂载：草稿 + 合集 + 模型目录 + 布局 + 上次选的模型                   */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      try {
        const [draft, libraryNow, catalogNow, layoutNow, choiceNow] = await Promise.all([
          loadDraft(),
          loadLibrary(),
          catalogProp ? Promise.resolve(catalogProp) : loadCatalog(),
          loadLayout(),
          loadModelChoice(),
        ]);
        if (!aliveRef.current) return;

        setLibrary(libraryNow);
        if (!catalogProp) setCatalog(catalogNow);
        setBody(draft.body);
        if (draft.updatedAt > 0) setSaveStatus('saved');
        // P5：上次「存为记录」的指纹一并恢复 —— 否则刷新后按钮会谎称「没存过」
        setSavedFingerprint(draft.savedFingerprint ?? null);

        // 布局：先放进内存，再交给 clamp 效应按真实宽度夹一次
        layoutRef.current = layoutNow;
        setLayout(layoutNow);
        setLayoutReady(true);
        setModelChoice(choiceNow);

        if (draft.materialIds.length > 0) {
          // 悬空 id 在这一步被过滤掉（listRecordsByIds 会跳过不存在的 id）
          const rows = await listRecordsByIds(draft.materialIds);
          if (!aliveRef.current) return;
          setMaterials(rows);
          const pruned = pruneDraftMaterials(draft, new Set(rows.map((item) => item.id)));
          // 只有真的清掉了什么才写回：干净草稿不该因为「打开页面」而多一次写库
          if (pruned !== draft) await saveDraft(pruned);
        }

        hydratedRef.current = true;
      } catch (caught) {
        // 卸载后才失败：什么也不写（写进去只会在环境拆掉之后变成未处理拒绝）
        if (!aliveRef.current) return;
        setError(describeError(caught));
        setRecords([]);
      }
    })();

    return () => {
      aliveRef.current = false;
    };
    // 只在挂载时读一次：catalogProp 变了也不重读草稿（会覆盖用户正在写的东西）
  }, []);

  /* ------------------------------------------------------------------ */
  /* 左栏查询：合集 → 搜索（不复用合集时走 listRecords）                  */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      try {
        const active = findCollection(library, collectionId);
        const options = {
          tag: undefined,
          search: search || undefined,
          page: 1,
          pageSize: MATERIAL_PAGE_SIZE,
        };
        if (active) {
          // 合集视图：顺序 = 合集自己的 recordIds 顺序（P2b 定的），不掺置顶
          const result = await listRecordsInOrder(active.recordIds, options);
          if (!aliveRef.current) return;
          setRecords(result.items);
          setListTotal(result.total);
          return;
        }
        // 「全部」视图（P4c §6.1）：置顶的排前面，其余按时间倒序 ——
        // 待选素材**没有**全局手动排序（P2b 已定：全局顺序不可维护），
        // 所以这里只有「置顶优先 + createdAt 倒序」两条，没有第三个来源。
        const [result, pinnedRows] = await Promise.all([
          listRecords({ ...options, excludeIds: library.pins }),
          library.pins.length > 0
            ? listRecordsByIds(library.pins, { search: search || undefined })
            : Promise.resolve<RecordSummary[]>([]),
        ]);
        if (!aliveRef.current) return;
        setRecords([...pinnedRows, ...result.items]);
        setListTotal(result.total + pinnedRows.length);
      } catch (caught) {
        if (!aliveRef.current) return;
        setError(describeError(caught));
        setRecords([]);
      }
    })();
  }, [library, collectionId, search, listVersion]);

  /* ---- P5：三段筛选的条数（全库口径）+ 来源标题缓存 ---- */

  useEffect(() => {
    void (async () => {
      try {
        const counts = await countRecordsByRole();
        if (!aliveRef.current) return;
        setRoleCounts(counts);
      } catch {
        // 统计失败不该影响主列表：chip 上不显示数字即可
        if (aliveRef.current) setRoleCounts(null);
      }
    })();
  }, [listVersion, library]);

  // 左栏每条「来自「…」」要显示来源正文：把当前列表里出现过的 sourceIds 一次查回来
  // （`listRecordsByIds` 会跳过已被删的 id —— 那种就只显示「来自已删除的记录」，不报错）
  useEffect(() => {
    const ids = Array.from(
      new Set((records ?? []).flatMap((record) => record.sourceIds ?? [])),
    );
    if (ids.length === 0) {
      setSourceTitles(new Map());
      return;
    }
    void (async () => {
      try {
        const rows = await listRecordsByIds(ids);
        if (!aliveRef.current) return;
        setSourceTitles(new Map(rows.map((row) => [row.id, row.text])));
      } catch {
        // 拿不到标题就不显示「来自」那一行，比显示一个错标题好
      }
    })();
  }, [records]);

  // 搜索：300ms 防抖，避免每敲一个字就查一次库
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  /* ------------------------------------------------------------------ */
  /* 布局：持久化 / 窗口变小兜底                                          */
  /* ------------------------------------------------------------------ */

  // 拖拽松手、折叠、全部收起 —— 都从这一条出口写库（180ms 防抖：拖动时每帧都改宽度）
  useEffect(() => {
    layoutRef.current = layout;
    if (!layoutReady) return;
    const timer = window.setTimeout(() => {
      if (!aliveRef.current) return;
      void saveLayout(layout).catch((caught) => {
        if (!aliveRef.current) return;
        setError(describeError(caught));
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [layout, layoutReady]);

  // 窗口尺寸变化：宽度用来夹两栏，高度用来夹展示区。
  // **只夹渲染，不写回存储** —— 否则在小窗口打开一次工作台，就把用户原来的宽栏/高度永久压小
  useEffect(() => {
    if (!layoutReady) return;
    function fit(): void {
      const element = bodyElRef.current;
      if (!element) return;
      const total = element.clientWidth;
      if (total > 0) setContainerWidth(total);
      const center = centerElRef.current;
      if (center && center.clientHeight > 0) setContainerHeight(center.clientHeight);
    }
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [layoutReady]);

  function beginResize(side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>): void {
    const container = bodyElRef.current;
    if (!container) return;
    // 折叠状态下没有分隔条（那一侧是 36px 窄条），不进入拖拽
    if (side === 'left' ? layout.leftCollapsed : layout.rightCollapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === 'left' ? view.leftWidth : view.rightWidth,
      total: container.clientWidth,
    };
    setDraggingSide(side);
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    setLayout((current) => {
      const next =
        drag.side === 'left'
          ? resizeLeft(current, drag.startWidth + delta, drag.total)
          : resizeRight(current, drag.startWidth - delta, drag.total);
      layoutRef.current = next;
      return next;
    });
  }

  function endResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraggingSide(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已经不在（拖到窗口外松手）：没有 capture 可释放，忽略
    }
    if (!aliveRef.current) return;
    void saveLayout(layoutRef.current).catch((caught) => {
      if (!aliveRef.current) return;
      setError(describeError(caught));
    });
  }

  function setPaneCollapsed(pane: 'display' | 'left' | 'right', collapsed: boolean): void {
    setLayout((current) => {
      if (pane === 'left') return { ...current, leftCollapsed: collapsed };
      if (pane === 'right') return { ...current, rightCollapsed: collapsed };
      return { ...current, displayCollapsed: collapsed };
    });
  }
  function toggleAllPanes(): void {
    setLayout((current) => (isAllCollapsed(current) ? expandAll(current) : collapseAll(current)));
  }

  /* ---- 横向分隔条（展示区 / 正文之间）---- */

  function beginDisplayResize(event: React.PointerEvent<HTMLDivElement>): void {
    const center = centerElRef.current;
    if (!center) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    heightDragRef.current = {
      startY: event.clientY,
      startHeight: displayHeight,
      available: center.clientHeight,
    };
    setDraggingDisplay(true);
  }

  function moveDisplayResize(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = heightDragRef.current;
    if (!drag) return;
    // 往下拖 = 展示区变高；用增量算，拖再快也不会「跳格」
    const requested = drag.startHeight + (event.clientY - drag.startY);
    setLayout((current) => {
      const next = resizeDisplayHeight(current, requested, drag.available);
      layoutRef.current = next;
      return next;
    });
  }

  function endDisplayResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (!heightDragRef.current) return;
    heightDragRef.current = null;
    setDraggingDisplay(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已经不在（拖到窗口外松手）：没有 capture 可释放，忽略
    }
    if (!aliveRef.current) return;
    void saveLayout(layoutRef.current).catch((caught) => {
      if (!aliveRef.current) return;
      setError(describeError(caught));
    });
  }


  /* ------------------------------------------------------------------ */
  /* 中栏：挑选素材（点击与拖拽共用同一条出口）                            */
  /* ------------------------------------------------------------------ */

  const materialIds = materials.map((item) => item.id);

  /**
   * P5：当前这一版草稿的指纹（正文 + 排序后的素材 id）。
   *
   * `alreadySaved` 为真 = 「正文与素材都和上次存下来的一模一样」→ 按钮变「已保存」禁用；
   * 改一个字、加/减一条素材都会让它重新变成 false（详见 `core/studio/draft` 的
   * `fingerprintDraft`）。
   */
  const currentFingerprint = fingerprintDraft(body, materialIds);
  const alreadySaved = savedFingerprint !== null && savedFingerprint === currentFingerprint;
  const canSaveAsRecord = countBodyChars(body) > 0 && !alreadySaved && !savingRecord;

  /**
   * 「存为记录」（P5 §3，本轮核心里程碑）：把正文变成一条**成品记录**。
   *
   * 三条行为约定：
   * 1. 写 `role: 'draft'` + `sourceIds: 当前素材`（顺序就是展示区顺序），标签一律空
   *    —— 不给用户预设标签，标签是他自己的分类；
   * 2. **草稿不清空**：正文留着，用户可能接着改再存一版（`savedFingerprint` 只挡住
   *    "完全没变"的重复点击，不挡"改了之后存新版"）；
   * 3. 存完把指纹立刻写进草稿，不等 500ms 自动保存 —— 存完马上关页面也不会退回「没存过」。
   */
  async function saveAsRecord(): Promise<void> {
    if (!canSaveAsRecord) return;
    const text = body;
    const ids = materialIds.slice();
    const fingerprint = currentFingerprint;
    setSavingRecord(true);
    setNotice(null);
    try {
      await createRecord({ text, role: 'draft', sourceIds: ids, tags: [] });
      if (!aliveRef.current) return;
      setSavedFingerprint(fingerprint);
      setListVersion((value) => value + 1);
      setNotice(
        ids.length > 0
          ? `已存为记录（成品 · 来自 ${ids.length} 条素材）—— 首页能看到它`
          : '已存为记录（成品）—— 首页能看到它',
      );
      await saveDraft({ body: text, materialIds: ids, updatedAt: 0, savedFingerprint: fingerprint });
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(describeError(caught));
    } finally {
      if (aliveRef.current) setSavingRecord(false);
    }
  }

  /**
   * 复制素材（P5 §5）：新建一条**副本记录**，原记录一个字都不改。
   *
   * 与卡片上那个「复制」不是同一件事：那个是**复制到剪贴板**（拿去贴到别处），
   * 这个是**在库里另存一条**（血缘留在 `sourceIds`），列表里会标「副本」。
   */
  async function duplicateMaterial(material: RecordSummary): Promise<void> {
    setNotice(null);
    try {
      await duplicateRecord(material.id);
      if (!aliveRef.current) return;
      setListVersion((value) => value + 1);
      setNotice('已复制成一条新记录（副本）—— 原记录没动');
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(describeError(caught));
    }
  }

  /** 加一条素材：**上限只在这里判一次**，点击与拖拽都走这里 */
  function addMaterial(record: RecordSummary): void {
    if (materialIds.includes(record.id)) {
      setNotice('这条素材已经在展示区里了');
      return;
    }
    if (materials.length >= MAX_MATERIALS) {
      // 不勾上，也不偷偷顶替掉已有的一条 —— 用户没说要换谁
      setNotice(`最多 ${MAX_MATERIALS} 条素材 —— 先关掉一张卡再选新的`);
      return;
    }
    setNotice(null);
    setMaterials([...materials, record]);
  }

  function toggleMaterial(record: RecordSummary): void {
    if (materialIds.includes(record.id)) {
      setMaterials(materials.filter((item) => item.id !== record.id));
      setNotice(null);
      return;
    }
    addMaterial(record);
  }

  function removeMaterial(recordId: string): void {
    setMaterials(materials.filter((item) => item.id !== recordId));
    if (editingId === recordId) setEditingId(null);
    setNotice(null);
  }

  function handleMaterialDragStart(
    record: RecordSummary,
    event: React.DragEvent<HTMLLIElement>,
  ): void {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(STUDIO_DRAG_TYPE, record.id);
    // 也放一份 text/plain：拖到别的应用（或编辑器）里仍然有意义
    event.dataTransfer.setData('text/plain', record.text || record.id);
  }

  function handleDropZoneOver(event: React.DragEvent<HTMLElement>): void {
    if (layout.displayCollapsed) return;
    const { types } = event.dataTransfer;
    if (!types.includes(STUDIO_DRAG_TYPE) && !types.includes('text/plain')) return;
    // 不 preventDefault 就永远收不到 drop 事件（浏览器的默认行为是「不接受」）
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  }

  function handleDropZoneLeave(event: React.DragEvent<HTMLElement>): void {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return; // 还在展示区里转
    setDropActive(false);
  }

  function handleDropZoneDrop(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDropActive(false);
    const id =
      event.dataTransfer.getData(STUDIO_DRAG_TYPE) || event.dataTransfer.getData('text/plain');
    if (!id) return;
    // 只接受「左栏当前列表里的」素材：拖进来的可能是一段外部文字，不能直接当记录用
    const record = (records ?? []).find((item) => item.id === id);
    if (!record) {
      setNotice('这条素材不在当前列表里 —— 先清掉搜索或切回「全部」再拖');
      return;
    }
    addMaterial(record);
  }

  /* ------------------------------------------------------------------ */
  /* 单卡操作条：编辑 / 复制（P4c §2：三个按钮砍到两个，「加入合集」删除）  */
  /* ------------------------------------------------------------------ */

  function beginEdit(material: RecordSummary): void {
    setEditingId(material.id);
    setEditingText(material.text);
  }

  function commitEdit(): void {
    const id = editingId;
    if (!id) return;
    const next = editingText;
    setEditingId(null);
    const before = materials.find((item) => item.id === id);
    if (!before || before.text === next) return;
    // 先改屏幕（.studio-card 立刻显示新文字），写库失败再回滚 —— 不让输入白敲
    setMaterials((list) => list.map((item) => (item.id === id ? { ...item, text: next } : item)));
    void updateRecord(id, { text: next })
      .then(() => {
        if (!aliveRef.current) return;
        setNotice('素材原文已更新');
      })
      .catch((caught) => {
        if (!aliveRef.current) return;
        setMaterials((list) =>
          list.map((item) => (item.id === id ? { ...item, text: before.text } : item)),
        );
        setError(describeError(caught));
      });
  }

  async function copyMaterial(material: RecordSummary): Promise<void> {
    const text = material.text;
    if (text === '') {
      setNotice('这条素材没有文字，只有录音 —— 没有可复制的内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      if (!aliveRef.current) return;
      setNotice('素材全文已复制');
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(describeError(caught));
    }
  }

  /* ------------------------------------------------------------------ */
  /* 展示区卡片换序（P4c §6.2）：数组顺序 = 【素材N】编号                  */
  /* ------------------------------------------------------------------ */

  /**
   * 拖卡片换序用的是**另一个** dataTransfer 类型：展示区本身也是一个 drop 区
   * （左栏拖进来 = 加素材）。两种 drop 混在一个 zone 里，靠类型区分，不靠"猜"。
   */
  function handleCardDragStart(index: number, event: React.DragEvent<HTMLElement>): void {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(STUDIO_REORDER_TYPE, String(index));
    setReorder({ from: index, to: index, side: 'before' });
  }

  function handleCardDragOver(index: number, event: React.DragEvent<HTMLElement>): void {
    if (!event.dataTransfer.types.includes(STUDIO_REORDER_TYPE)) return;
    // 不 preventDefault 就收不到 drop（浏览器的默认行为是「不接受」）
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    // 落点在卡片左半 → 插到这张前面；右半 → 插到这张后面
    const rect = event.currentTarget.getBoundingClientRect();
    const side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setReorder((current) =>
      current && current.to === index && current.side === side
        ? current
        : { from: current?.from ?? index, to: index, side },
    );
  }

  function handleCardDrop(index: number, event: React.DragEvent<HTMLElement>): void {
    const raw = event.dataTransfer.getData(STUDIO_REORDER_TYPE);
    if (raw === '') return;
    event.preventDefault();
    event.stopPropagation();
    const from = Number.parseInt(raw, 10);
    const drop = reorder;
    setReorder(null);
    setDropActive(false);
    if (!Number.isInteger(from) || from < 0 || from >= materials.length) return;
    // 落位点要换算成「移除 from 之后的下标」：往后拖时目标下标会前移一位
    let to = index + (drop?.side === 'after' ? 1 : 0);
    if (from < to) to -= 1;
    const currentIds = materials.map((item) => item.id);
    const nextIds = moveMaterialId(currentIds, from, to);
    // 落在原位时 moveMaterialId 原样返回同一个数组 —— 不要白写一次草稿
    if (nextIds === currentIds) return;
    const byId = new Map(materials.map((item) => [item.id, item]));
    const next = nextIds.map((id) => byId.get(id)).filter((item): item is RecordSummary => !!item);
    setMaterials(next);
    setNotice(`素材顺序已调整 —— AI 会按新编号读（素材 ${from + 1} → 素材 ${to + 1}）`);
  }

  function handleCardDragEnd(): void {
    setReorder(null);
  }

  /* ------------------------------------------------------------------ */
  /* 自动保存（500ms 防抖）                                              */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!hydratedRef.current) return;
    const ids = materials.map((item) => item.id);
    const timer = window.setTimeout(() => {
      if (!aliveRef.current) return;
      setSaveStatus('saving');
      // P5：指纹跟着草稿一起落库 —— 刷新后「已保存」状态要能恢复
      const payload = savedFingerprint
        ? { body, materialIds: ids, updatedAt: 0, savedFingerprint }
        : { body, materialIds: ids, updatedAt: 0 };
      void saveDraft(payload)
        .then(() => {
          if (!aliveRef.current) return;
          setSaveStatus('saved');
        })
        .catch((caught) => {
          if (!aliveRef.current) return;
          setSaveStatus('idle');
          setError(describeError(caught));
        });
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [body, materials, savedFingerprint]);

  /* ------------------------------------------------------------------ */
  /* 右栏：AI                                                           */
  /* ------------------------------------------------------------------ */

  // 显式选过的模型优先；没选过就按能力自动挑一个（`pickModel`）
  const picked = useMemo<PickModelResult | null>(
    () => resolveStudioModel(catalog, modelChoice),
    [catalog, modelChoice],
  );
  const modelOptions = useMemo(() => studioModelOptions(catalog), [catalog]);
  /**
   * 现在**实际生效**的是哪一个（下拉里打勾的那一行）。
   * 不能只比 `modelChoice`：没显式选过时，生效的是 `pickModel` 自动挑的那个，
   * 那样下拉里会一行都不勾，用户看不出「现在用的是谁」。
   */
  const activeModelKey =
    picked?.ok && picked.provider && picked.model
      ? `${picked.provider.id}::${picked.model.modelId}`
      : null;
  const bodyChars = countBodyChars(body);
  const modelLabel =
    picked?.ok && picked.model
      ? picked.model.displayName || picked.model.modelId
      : MODEL_NOT_CONFIGURED;

  function chooseModel(option: StudioModelOption): void {
    setModelMenuOpen(false);
    const choice: StudioModelChoice = { providerId: option.providerId, modelId: option.modelId };
    setModelChoice(choice);
    void saveModelChoice(choice).catch((caught) => {
      if (!aliveRef.current) return;
      setError(describeError(caught));
    });
    setNotice(`已切到 ${option.displayName}`);
  }

  /* ---- 模型下拉：打开坐标 / 键盘 / 点外部关闭（P4c §3 §5） ---- */

  function optionKeyOf(option: StudioModelOption): string {
    return `${option.providerId}::${option.modelId}`;
  }

  /**
   * 打开时**把菜单挂到 body**（`position: fixed`），坐标从按钮的真实矩形算：
   * 右边缘对齐按钮右边缘、顶边在按钮下方 6px。这样既不会被 `.studio-right` 的
   * `overflow: hidden` 裁掉，也不会被展示区盖住（层叠上下文里它已经在 body 上）。
   */
  function openModelMenu(): void {
    const current = modelOptions.findIndex((option) => optionKeyOf(option) === activeModelKey);
    // 打开时高亮当前生效的模型；一个都没命中就高亮第一行
    setModelActiveIndex(current >= 0 ? current : 0);
    const button = modelBtnRef.current;
    if (button) {
      const rect = button.getBoundingClientRect();
      setModelMenuBox({
        right: Math.max(MENU_EDGE_GAP, Math.round(window.innerWidth - rect.right)),
        top: Math.round(rect.bottom + 6),
      });
    }
    setModelMenuOpen(true);
  }

  function closeModelMenu(): void {
    setModelMenuOpen(false);
  }

  /** 键盘：↑↓ 移高亮 / Enter 选中 / Esc 关闭（不论焦点在按钮上还是菜单项上） */
  function handleModelKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      if (!modelMenuOpen) return;
      event.preventDefault();
      closeModelMenu();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (modelOptions.length === 0) return;
      event.preventDefault();
      // 菜单没开时，第一次按方向键先把菜单打开（高亮落在当前模型上）
      if (!modelMenuOpen) {
        openModelMenu();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setModelActiveIndex(
        (index) => (index + step + modelOptions.length) % modelOptions.length,
      );
      return;
    }
    if (event.key === 'Enter' && modelMenuOpen) {
      event.preventDefault();
      const option = modelOptions[modelActiveIndex];
      if (option) chooseModel(option);
    }
  }

  // 点菜单外面 / 窗口尺寸变了 → 关。菜单在 body 上，所以按钮和菜单两边都要判
  useEffect(() => {
    if (!modelMenuOpen) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (!target) return;
      if (modelMenuRef.current?.contains(target)) return;
      // 点按钮本身交给它的 onClick 切换，别在这里抢
      if (modelBtnRef.current?.contains(target)) return;
      setModelMenuOpen(false);
    }
    function onResize(): void {
      setModelMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [modelMenuOpen]);

  // 高亮走到滚动区外面时把它带进视野（jsdom 没有 scrollIntoView，先判一下）
  useEffect(() => {
    if (!modelMenuOpen) return;
    const node = modelMenuRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [modelMenuOpen, modelActiveIndex]);

  /** 默认实现：走**现有** `chat()`（任务书红线 8：不许新写请求层） */
  const defaultGenerate = useCallback<StudioGenerator>(
    async (prompt) => {
      if (!picked?.ok || !picked.provider || !picked.connection || !picked.model) {
        throw new Error(picked?.hint ?? capHint('text'));
      }
      const connection = activeConnectionFor(
        catalog ?? { providers: [], updatedAt: 0 },
        picked.provider.id,
      );
      if (!connection) throw new Error('这个模型所属的连接找不到了：去 AI 配置确认一下');

      const response = await chat(
        {
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey ?? '',
          model: picked.model.modelId,
          protocol: connection.protocol,
          timeoutMs: GENERATE_TIMEOUT_MS,
        },
        {
          model: picked.model.modelId,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          max_tokens: 1500,
        },
      );
      if (!response.success) throw new Error(response.error.userMessage);
      return response.content;
    },
    [picked, catalog],
  );

  const runGenerate = generate ?? defaultGenerate;

  async function handleSend(): Promise<void> {
    if (!picked?.ok || busy) return;
    const ask = instruction.trim();
    const user = buildStudioUserMessage(materials, body, ask);
    const shown = ask === '' ? '按现在的素材和正文接着写' : ask;
    const materialCount = materials.length;
    const chars = bodyChars;

    setBusy(true);
    setAiError(null);
    setMessages((current) => [
      ...current,
      {
        id: nextMessageId(),
        role: 'user',
        text: shown,
        // 徽标展开要能看到「它到底看到了什么」：存的就是这一串，不是重算的摘要
        context: user,
        contextMaterials: materialCount,
        contextChars: chars,
      },
    ]);
    try {
      const text = await runGenerate({ system: STUDIO_SYSTEM_PROMPT, user });
      if (!aliveRef.current) return;
      setMessages((current) => [...current, { id: nextMessageId(), role: 'ai', text }]);
      setInstruction('');
    } catch (caught) {
      if (!aliveRef.current) return;
      setAiError(describeError(caught));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  /* ---- 三个落笔动作（只有这三条路会改正文） ---- */

  function rememberCaret(): void {
    const element = bodyInputRef.current;
    if (!element) return;
    caretRef.current = element.selectionStart;
  }

  // 改完正文把光标放回插入点之后（否则焦点丢了，用户接着打字会落在别处）
  useEffect(() => {
    const target = pendingCaretRef.current;
    const element = bodyInputRef.current;
    if (target === null || !element) return;
    pendingCaretRef.current = null;
    element.focus();
    element.setSelectionRange(target, target);
    caretRef.current = target;
  }, [body]);

  /** 替换正文：先确认一次，确认后才真的覆盖（不可撤销的动作不允许一点就走） */
  function applyReplace(message: StudioMessage): void {
    setBody(message.text);
    setConfirmReplaceId(null);
    setNotice('已用 AI 这版替换正文');
  }

  /** 插入光标处：没有光标（还没点过正文）就落到末尾 */
  function insertAtCaret(message: StudioMessage): void {
    const caret = caretRef.current;
    const at = caret === null || caret < 0 || caret > body.length ? body.length : caret;
    const before = body.slice(0, at);
    const after = body.slice(at);
    // 插在句子中间时先补一个换行，避免「上一句」和 AI 那句粘成一行
    const prefix = before !== '' && !before.endsWith('\n') ? '\n' : '';
    const inserted = `${prefix}${message.text}`;
    setBody(before + inserted + after);
    pendingCaretRef.current = at + inserted.length;
    setNotice('已插入光标处');
  }

  /** 追加末尾：直接加在正文最后，空一行 */
  function appendToEnd(message: StudioMessage): void {
    const trimmed = body.replace(/\s+$/, '');
    const next = trimmed === '' ? message.text : `${trimmed}\n\n${message.text}`;
    setBody(next);
    pendingCaretRef.current = next.length;
    setNotice('已追加到正文末尾');
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                               */
  /* ------------------------------------------------------------------ */

  const saveLabel =
    saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '已自动保存' : '尚未保存';
  const allCollapsed = isAllCollapsed(layout);
  const displayCount = displayCountOf(materials.length);
  /** P5：三段筛选后的左栏列表（内存过滤；`records` 本身不动，切回「全部」立即还原） */
  const leftRecords = (records ?? []).filter((record) => matchesRoleFilter(record, roleFilter));
  // 窄窗口下按真实外壳宽度夹一次**再渲染**（`layout` 本身不动 → 刷新还能回到用户拖出来的宽度）
  const view = containerWidth > 0 ? clampLayout(layout, containerWidth) : layout;
  const leftWidth = view.leftCollapsed ? COLLAPSED_WIDTH : view.leftWidth;
  const rightWidth = view.rightCollapsed ? COLLAPSED_WIDTH : view.rightWidth;
  /**
   * 展示区高度（P4c §4）：存的是 `layout.displayHeight`，渲染时按中栏真实高度夹一次
   * （窗口变矮不该让正文被挤没；**夹的是渲染值，不写回存储**，同栏宽那条取舍）。
   */
  const displayHeight =
    containerHeight > 0
      ? fitDisplayHeight(view.displayHeight, containerHeight)
      : Math.max(MIN_DISPLAY_HEIGHT, view.displayHeight);

  return (
    <section className="page page-studio">
      <header className="studio-head">
        <h2 className="studio-title">写作工作台</h2>
        {/* 这里只报状态，字数归正文那一条（两处都写「已有 N 字 · 已自动保存」=
            同一句话说两遍，样张里顶栏也只写状态） */}
        <span className="studio-save" data-studio-save={saveStatus}>
          {saveLabel}
        </span>
        {/* 一键回到「只有正文」；都收起来了就变成「展开全部」 */}
        <button
          type="button"
          className="studio-collapse-all"
          data-studio-collapse-all
          aria-pressed={allCollapsed}
          onClick={toggleAllPanes}
        >
          {allCollapsed ? '展开全部' : '全部收起'}
        </button>
      </header>

      {error && <p className="error studio-error">{error}</p>}

      <div className="studio-body" ref={bodyElRef}>
        {/* ---------------- 左：素材 ---------------- */}
        <aside
          className="studio-left"
          aria-label="素材"
          data-studio-pane="left"
          data-collapsed={layout.leftCollapsed ? 'true' : undefined}
          style={{ width: leftWidth }}
        >
          <button
            type="button"
            className="studio-strip"
            data-studio-strip="left"
            hidden={!layout.leftCollapsed}
            aria-label="展开素材栏"
            onClick={() => setPaneCollapsed('left', false)}
          >
            <span className="studio-strip-label">素材</span>
            <span className="studio-strip-caret" aria-hidden="true">
              ›
            </span>
          </button>

          {/* 折叠只是 hidden：搜索词、滚动位置都还在这份 DOM 里 */}
          <div className="studio-pane" hidden={layout.leftCollapsed}>
            <div className="studio-left-head">
              <div className="studio-pane-head">
                <span className="studio-eyebrow">素材</span>
                <button
                  type="button"
                  className="studio-fold"
                  data-studio-fold="left"
                  aria-label="收起素材栏"
                  title="收成窄条"
                  onClick={() => setPaneCollapsed('left', true)}
                >
                  ⟨
                </button>
              </div>
              <input
                type="search"
                className="studio-search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="搜索记录…"
                aria-label="搜索素材"
              />
              {/* P5 §6：三段筛选（全部 / 我写的 / AI 产出）。
                  类名刻意不叫 `.studio-chip` —— 合集 chip 的既有断言是靠
                  「textContent 以『全部』开头」定位的，两排同名会互相抢。 */}
              <div className="studio-roles" role="group" aria-label="按来源筛选">
                {ROLE_FILTERS.map((item) => {
                  const on = roleFilter === item.key;
                  const count = roleCounts
                    ? item.key === 'all'
                      ? roleCounts.all
                      : item.key === 'mine'
                        ? roleCounts.mine
                        : roleCounts.ai
                    : null;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`studio-role${on ? ' on' : ''}`}
                      data-studio-role-filter={item.key}
                      aria-pressed={on}
                      onClick={() => setRoleFilter(item.key)}
                    >
                      {item.label}
                      {count !== null && <span className="studio-role-count">{count}</span>}
                    </button>
                  );
                })}
              </div>
              {/* 合集筛选：**没有合集时整排不渲染** —— 否则它只剩一个「全部 N」，
                  和上面那排三段筛选的「全部 N」是同一句话说两遍（截图里看得很清楚）。 */}
              {library.collections.length > 0 && (
                <div className="studio-chips" role="group" aria-label="合集筛选">
                  <button
                    type="button"
                    className={`studio-chip${collectionId === null ? ' on' : ''}`}
                    aria-pressed={collectionId === null}
                    onClick={() => setCollectionId(null)}
                  >
                    全部<span className="studio-chip-count">{listTotal}</span>
                  </button>
                  {library.collections.map((collection) => (
                    <button
                      key={collection.id}
                      type="button"
                      className={`studio-chip${collectionId === collection.id ? ' on' : ''}`}
                      aria-pressed={collectionId === collection.id}
                      onClick={() => setCollectionId(collection.id)}
                    >
                      {collection.name}
                      <span className="studio-chip-count">{collection.recordIds.length}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {records === null ? (
              <p className="muted studio-left-state">正在读取本地记录…</p>
            ) : records.length === 0 ? (
              <div className="studio-left-state">
                <p>
                  {library.collections.length > 0 && collectionId
                    ? '这个合集里还没有记录。'
                    : search
                      ? '没有匹配的记录。'
                      : '还没有记录。先去首页写一条，它会出现在这里。'}
                </p>
                <Link className="button ghost" to="/">
                  去首页写一条
                </Link>
              </div>
            ) : leftRecords.length === 0 ? (
              // 库里有记录，但这一段筛选（我写的 / AI 产出）下没有 → 说清是筛选的结果
              <p className="muted studio-left-state" data-studio-role-empty>
                {roleFilter === 'ai'
                  ? '还没有 AI 产出的素材。'
                  : '这一段里没有记录 —— 点「全部」看看。'}
              </p>
            ) : (
              <ul className="studio-materials">
                {leftRecords.map((record) => {
                  const on = materialIds.includes(record.id);
                  // P5 §6：来源那一行（「来自「凌晨三点的图书馆」」）；来源被删就说被删了
                  const firstSourceId = (record.sourceIds ?? [])[0];
                  const sourceText = firstSourceId ? sourceTitles.get(firstSourceId) : undefined;
                  const sourceLabel = firstSourceId
                    ? sourceText
                      ? `来自「${sourceText.slice(0, 16)}${sourceText.length > 16 ? '…' : ''}」`
                      : '来自已删除的记录'
                    : '';
                  const isCopy = isCopyLike(record.role, record.sourceIds);
                  return (
                    // 拖动挂在 li 上（button 在部分浏览器里不可拖）：点仍然是勾选，拖是另一条路
                    <li
                      key={record.id}
                      className="studio-material-item"
                      data-material-role={normalizeRole(record.role)}
                      draggable
                      onDragStart={(event) => handleMaterialDragStart(record, event)}
                    >
                      <button
                        type="button"
                        className={`studio-material${on ? ' on' : ''}`}
                        data-studio-material={record.id}
                        aria-pressed={on}
                        aria-label={`${on ? '取消勾选' : '勾选'}：${record.text.slice(0, 20)}`}
                        onClick={() => toggleMaterial(record)}
                      >
                        <span className="studio-material-box" aria-hidden="true">
                          {on ? '✓' : ''}
                        </span>
                        <span className="studio-material-main">
                          <span className="studio-material-text">
                            {record.text || '（无文字，仅录音）'}
                          </span>
                          <span className="studio-material-meta">
                            {materialMeta(record)}
                            {isCopy && <span className="studio-material-tag">副本</span>}
                            {isAssetRole(record.role) && (
                              <span className="studio-material-tag">AI 产出</span>
                            )}
                          </span>
                          {sourceLabel && (
                            <span className="studio-material-source" data-studio-source-hint>
                              {sourceLabel}
                            </span>
                          )}
                        </span>
                      </button>
                      {/* P5 §5：hover 出现「复制」= 在库里另存一条副本（原记录一个字都不改）。
                          它是 li 的兄弟节点而不是嵌套在勾选按钮里 —— 按钮不能套按钮。 */}
                      <button
                        type="button"
                        className="studio-material-copy"
                        data-studio-material-copy={record.id}
                        title="另存为一条副本（原记录不变）"
                        onClick={() => void duplicateMaterial(record)}
                      >
                        复制
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        <div
          className="studio-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整素材栏宽度"
          aria-valuenow={layout.leftWidth}
          tabIndex={-1}
          data-studio-splitter="left"
          data-dragging={draggingSide === 'left' ? 'true' : undefined}
          hidden={layout.leftCollapsed}
          onPointerDown={(event) => beginResize('left', event)}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />

        {/* ---------------- 中：展示区 + 横向分隔条 + 正文 ---------------- */}
        <main className="studio-center" ref={centerElRef}>
          {notice && (
            <p className="studio-notice" role="status">
              {notice}
            </p>
          )}

          <section
            className="studio-display"
            data-studio-display
            data-count={displayCount}
            data-collapsed={layout.displayCollapsed ? 'true' : undefined}
            data-drop-active={dropActive ? 'true' : undefined}
            // 高度由横向分隔条决定（P4c §4.2）；折叠时交给 CSS 的 36px
            style={layout.displayCollapsed ? undefined : { height: displayHeight }}
            onDragEnter={handleDropZoneOver}
            onDragOver={handleDropZoneOver}
            onDragLeave={handleDropZoneLeave}
            onDrop={handleDropZoneDrop}
          >
            <div className="studio-display-head">
              <span className="studio-eyebrow">展示区</span>
              <span className="studio-display-count" data-studio-display-count>
                {materials.length} 条
              </span>
              <button
                type="button"
                className="studio-fold"
                data-studio-fold="display"
                aria-expanded={!layout.displayCollapsed}
                onClick={() => setPaneCollapsed('display', !layout.displayCollapsed)}
              >
                {layout.displayCollapsed ? '展开 ⌄' : '收起 ⌃'}
              </button>
            </div>

            <div className="studio-display-body" hidden={layout.displayCollapsed}>
              {materials.length === 0 ? (
                <div className="studio-empty" data-studio-empty>
                  <p className="studio-empty-title">还没有展开的素材</p>
                  <p className="studio-empty-text">
                    从左边拖一条进来，或点一下选中 —— 它会展开在这里当参考。
                  </p>
                  <p className="studio-empty-hint">
                    {records && records.length > 0
                      ? '先勾一条试试 —— 右边可以让 AI 接着写。'
                      : '左栏还是空的。先在首页写一条记录，再回来勾选。'}
                  </p>
                </div>
              ) : (
                <div className="studio-cards" data-count={displayCount}>
                  {materials.map((material, index) => (
                    <article
                      className="studio-card"
                      data-studio-card={material.id}
                      data-dragging={reorder?.from === index ? 'true' : undefined}
                      // 落位提示：挂在「插到这张卡前面/后面」的那张卡上（一条竖线）
                      data-drop-side={reorder?.to === index ? reorder.side : undefined}
                      // 编辑中的卡不参与拖动：textarea 里要能选字
                      draggable={editingId !== material.id}
                      key={material.id}
                      onDragStart={(event) => handleCardDragStart(index, event)}
                      onDragOver={(event) => handleCardDragOver(index, event)}
                      onDrop={(event) => handleCardDrop(index, event)}
                      onDragEnd={handleCardDragEnd}
                    >
                      <div className="studio-card-head">
                        <span className="studio-card-no">素材 {index + 1}</span>
                        {/* P5 §4.3：这条记录是「写作成品」时，卡角给个角标 */}
                        {normalizeRole(material.role) === 'draft' && (
                          <span className="studio-card-role" data-studio-card-role>
                            成品
                          </span>
                        )}
                        <span className="studio-card-meta">{materialMeta(material)}</span>
                        <button
                          type="button"
                          className="studio-card-close"
                          aria-label={`关闭素材 ${index + 1}`}
                          onClick={() => removeMaterial(material.id)}
                        >
                          ✕
                        </button>
                      </div>

                      {editingId === material.id ? (
                        <textarea
                          className="studio-card-edit"
                          value={editingText}
                          autoFocus
                          aria-label={`编辑素材 ${index + 1} 原文`}
                          onChange={(event) => setEditingText(event.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setEditingId(null);
                            }
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              commitEdit();
                            }
                          }}
                        />
                      ) : (
                        <p
                          className="studio-card-text"
                          onDoubleClick={() => beginEdit(material)}
                          title="双击可以编辑原文；拖动卡片可以换顺序"
                        >
                          {material.text || '（无文字，仅录音）'}
                        </p>
                      )}

                      {/* P4c §2：只留「编辑」「复制」两个；「加入合集」按委托人的话删掉 */}
                      <div className="studio-card-actions">
                        <button type="button" onClick={() => beginEdit(material)}>
                          编辑
                        </button>
                        <button type="button" onClick={() => void copyMaterial(material)}>
                          复制
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* 横向分隔条（P4c §4）：拖动改变展示区高度；折叠展示区时隐藏 */}
          <div
            className="studio-hsplitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整展示区高度"
            aria-valuenow={displayHeight}
            tabIndex={-1}
            data-studio-hsplitter
            data-dragging={draggingDisplay ? 'true' : undefined}
            hidden={layout.displayCollapsed}
            onPointerDown={beginDisplayResize}
            onPointerMove={moveDisplayResize}
            onPointerUp={endDisplayResize}
            onPointerCancel={endDisplayResize}
          />

          <div className="studio-editor">
            <div className="studio-editor-head">
              <span className="studio-eyebrow">正文</span>
              <span className="studio-editor-stat" data-studio-stat>
                已有 {bodyChars} 字 · {saveLabel}
              </span>
              {/*
                P5 §3：本轮唯一的「正文 → 记录」出口。
                - 没有文字时不可点（空记录会被数据层拒掉，让按钮先说话）；
                - 存过且没改 → 「已保存」禁用（`savedFingerprint` 对得上）；
                - 改任何一处 → 恢复「存为记录」；再存一版是允许的（生成新记录）。
                不加弹窗确认：按钮状态已经把话说完了（任务书 §3.3 末句）。
              */}
              <button
                type="button"
                className="button primary studio-save-record"
                data-studio-save-record
                data-saved={alreadySaved ? 'true' : 'false'}
                disabled={!canSaveAsRecord}
                title={
                  alreadySaved
                    ? '正文与素材跟上次存的一模一样 —— 改一个字就能再存一版'
                    : bodyChars === 0
                      ? '先写点正文'
                      : '把正文存成一条记录（标「成品」，当前素材记为来源）'
                }
                onClick={() => void saveAsRecord()}
              >
                {savingRecord ? '保存中…' : alreadySaved ? '已保存' : '存为记录'}
              </button>
            </div>
            <textarea
              className="studio-body-input"
              data-studio-body
              ref={bodyInputRef}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                // 打字时把光标记下来（「插入光标处」要用）
                if (typeof event.target.selectionStart === 'number') {
                  caretRef.current = event.target.selectionStart;
                }
              }}
              onSelect={rememberCaret}
              onClick={rememberCaret}
              onKeyUp={rememberCaret}
              placeholder="继续写下去，或者让右边接着写…"
              aria-label="正文"
              spellCheck={false}
            />
          </div>
        </main>

        <div
          className="studio-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整 AI 栏宽度"
          aria-valuenow={layout.rightWidth}
          tabIndex={-1}
          data-studio-splitter="right"
          data-dragging={draggingSide === 'right' ? 'true' : undefined}
          hidden={layout.rightCollapsed}
          onPointerDown={(event) => beginResize('right', event)}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />

        {/* ---------------- 右：AI ---------------- */}
        <aside
          className="studio-right"
          aria-label="AI"
          data-studio-pane="right"
          data-collapsed={layout.rightCollapsed ? 'true' : undefined}
          style={{ width: rightWidth }}
        >
          <button
            type="button"
            className="studio-strip"
            data-studio-strip="right"
            hidden={!layout.rightCollapsed}
            aria-label="展开 AI 栏"
            onClick={() => setPaneCollapsed('right', false)}
          >
            <span className="studio-strip-caret" aria-hidden="true">
              ‹
            </span>
            <span className="studio-strip-label">AI</span>
          </button>

          <div className="studio-pane" hidden={layout.rightCollapsed}>
            <div className="studio-right-head">
              <span className="studio-eyebrow">AI</span>
              <div className="studio-model-wrap">
                <button
                  type="button"
                  className="studio-model"
                  data-studio-model-chip
                  ref={modelBtnRef}
                  aria-haspopup="listbox"
                  aria-expanded={modelMenuOpen}
                  disabled={modelOptions.length === 0}
                  title={
                    modelOptions.length === 0
                      ? '还没有可用的文本模型'
                      : '换一个带文本能力的模型（↑↓ 选 · Enter 确认 · Esc 关闭）'
                  }
                  onClick={() => (modelMenuOpen ? closeModelMenu() : openModelMenu())}
                  onKeyDown={handleModelKeyDown}
                >
                  {modelLabel}
                </button>
                {modelMenuOpen &&
                  modelOptions.length > 0 &&
                  modelMenuBox !== null &&
                  // 挂到 body：不参与 `.studio-right` 的 overflow 裁剪，也压得住展示区
                  createPortal(
                    <ul
                      className="studio-model-menu"
                      role="listbox"
                      aria-label="选择模型"
                      data-studio-model-menu
                      ref={modelMenuRef}
                      style={{ right: modelMenuBox.right, top: modelMenuBox.top }}
                      onKeyDown={handleModelKeyDown}
                    >
                      {modelOptions.map((option, index) => (
                        <li
                          key={`${option.providerId}::${option.modelId}`}
                          role="presentation"
                        >
                          <button
                            type="button"
                            role="option"
                            className="studio-model-opt"
                            aria-selected={activeModelKey === `${option.providerId}::${option.modelId}`}
                            data-active={index === modelActiveIndex ? 'true' : undefined}
                            data-studio-model-option={`${option.providerId}::${option.modelId}`}
                            onClick={() => chooseModel(option)}
                            onMouseEnter={() => setModelActiveIndex(index)}
                          >
                            <span className="studio-model-opt-name">{option.displayName}</span>
                            <span className="studio-model-opt-vendor">{option.providerName}</span>
                          </button>
                        </li>
                      ))}
                      <li className="studio-model-menu-foot">
                        <Link to="/ai-config" onClick={() => setModelMenuOpen(false)}>
                          管理模型与连接
                        </Link>
                      </li>
                    </ul>,
                    document.body,
                  )}
              </div>
              <button
                type="button"
                className="studio-fold"
                data-studio-fold="right"
                aria-label="收起 AI 栏"
                title="收成窄条"
                onClick={() => setPaneCollapsed('right', true)}
              >
                ⟩
              </button>
            </div>

            {picked === null ? (
              <p className="muted studio-ai-state">正在读取模型配置…</p>
            ) : !picked.ok ? (
              // 无可用文本模型：给可执行提示 + 出口，**不渲染发送按钮**
              //（一个按不动的按钮比没有按钮更糟；用户要做的是去配模型，不是点发送）
              <div className="studio-ai-state" data-studio-ai-hint>
                <p className="studio-ai-hint-title">⚠ 还没有可用的文本模型</p>
                <p className="studio-ai-hint-text">写作台的对话需要一个带「文本」能力的模型。</p>
                <p className="studio-ai-hint-text">{picked.hint ?? capHint('text')}</p>
                <Link className="button primary" to="/ai-config">
                  去 AI 配置加一个
                </Link>
              </div>
            ) : (
              <>
                <div className="studio-chat" data-studio-chat>
                  {messages.length === 0 && (
                    <p className="studio-chat-empty">
                      勾几条素材，写两行正文，然后让它接着写。
                    </p>
                  )}
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`studio-msg-row ${message.role === 'user' ? 'me' : 'ai'}`}
                      data-studio-message={message.role}
                    >
                      {/* 徽标在**每条**用户消息上方：让人知道「它看到了什么」 */}
                      {message.role === 'user' && message.context !== undefined && (
                        <button
                          type="button"
                          className="studio-ctx-badge"
                          data-studio-ctx-badge={message.id}
                          aria-expanded={openContextId === message.id}
                          onClick={() =>
                            setOpenContextId(openContextId === message.id ? null : message.id)
                          }
                        >
                          📎 {message.contextMaterials ?? 0} 条素材 · 正文{' '}
                          {message.contextChars ?? 0} 字
                        </button>
                      )}
                      {openContextId === message.id && message.context !== undefined && (
                        <pre className="studio-ctx-full" data-studio-ctx-full>
                          {message.context}
                        </pre>
                      )}

                      <div className={`studio-msg ${message.role === 'user' ? 'me' : 'ai'}`}>
                        <p className="studio-msg-text">{message.text}</p>
                        {message.role === 'ai' && (
                          <div className="studio-msg-actions">
                            <button
                              type="button"
                              className="studio-use pri"
                              data-studio-use={message.id}
                              onClick={() => setConfirmReplaceId(message.id)}
                            >
                              替换正文
                            </button>
                            <button
                              type="button"
                              className="studio-use"
                              data-studio-insert={message.id}
                              onClick={() => insertAtCaret(message)}
                            >
                              插入光标处
                            </button>
                            <button
                              type="button"
                              className="studio-use"
                              data-studio-append={message.id}
                              onClick={() => appendToEnd(message)}
                            >
                              追加末尾
                            </button>
                          </div>
                        )}
                      </div>

                      {confirmReplaceId === message.id && (
                        <div
                          className="studio-confirm"
                          role="alertdialog"
                          aria-label="确认替换正文"
                        >
                          <p>会覆盖现在的正文（{bodyChars} 字），这一步不可撤销。</p>
                          <div className="studio-confirm-actions">
                            <button
                              type="button"
                              className="button primary"
                              data-studio-confirm-replace
                              onClick={() => applyReplace(message)}
                            >
                              替换
                            </button>
                            <button
                              type="button"
                              className="button ghost"
                              onClick={() => setConfirmReplaceId(null)}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {aiError && <p className="error studio-ai-error">{aiError}</p>}

                <div className="studio-compose">
                  <textarea
                    className="studio-ask"
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="接着写，或者让它改写选中的段落…"
                    aria-label="给 AI 的要求"
                    spellCheck={false}
                  />
                  <div className="studio-compose-foot">
                    <span className="studio-compose-hint">
                      {contextHint(materials.length, bodyChars)}
                    </span>
                    <button
                      type="button"
                      className="button primary studio-send"
                      data-studio-send
                      disabled={busy}
                      onClick={() => void handleSend()}
                    >
                      {busy ? '生成中…' : '发送'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
