import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listAllTags,
  listRecords,
  listRecordsByIds,
  listRecordsInOrder,
} from '../../core/records';
import { isCopyLike, normalizeRole } from '../../core/records/meta';
import { loadExampleRecords } from '../../core/records/examples';
import type { ListRecordsResult, RecordSummary } from '../../core/records/types';
import type { TagCount } from '../../core/storage/queries';
import { countRecords, countSince, DEFAULT_PAGE_SIZE } from '../../core/storage/queries';
import { estimateQuota } from '../../core/storage';
import type { QuotaSnapshot } from '../../core/storage';
import { getVoiceSettings, saveVoiceSettings, VOICE_MODE_LABELS } from '../../core/settings';
import type { VoiceMode, VoiceSettings } from '../../core/settings';
import {
  addToCollection,
  createCollection,
  deleteCollection,
  emptyLibrary,
  findCollection,
  pruneMissing,
  removeFromCollection,
  renameCollection,
  reorderCollection,
  setPinned,
} from '../../core/library';
import type { Collection, Library } from '../../core/library';
import { formatDuration } from '../../core/media/recorder';
import { OnboardingPanel } from '../components/OnboardingPanel';
import { RecordEditor } from '../components/RecordEditor';
import { describeError, formatBytes, formatDateTime, startOfToday } from '../format';
import { scrollToTop } from '../scroll';

const EMPTY_LIST: ListRecordsResult = {
  items: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  pageCount: 0,
};

/**
 * 记录列表（P0 首页 → P2b 加置顶 / 合集 / 合集内排序）。
 *
 * 信息层级（自上而下）：
 *   标题 + 总数 → 搜索与标签同排 → 合集条 → 置顶区（有置顶才渲染）→ 全部（按时间倒序）→ 底栏
 *
 * 设计底线（任务书 §0）：**全局永远按时间倒序，只有「置顶」和「合集」对顺序有发言权。**
 * - 「全部」区不出现拖拽手柄，也不响应拖拽（`draggable` 属性在全部视图里根本不渲染）；
 * - 拖拽只在合集视图内可用，落下后写回 `collections[].recordIds`。
 *
 * 组合筛选语义（任务书 §3）：**先合集（若有）→ 再标签 → 再搜索 → 再分页**。
 * 合集视图走 `listRecordsInOrder`（顺序源是 recordIds），全部视图走 `listRecords`
 * 并把已置顶的 id 排除掉（`excludeIds`），因此置顶记录不会在「全部」里重复出现。
 *
 * 行为一律不改：搜索仍是 300ms 防抖、每页仍是 DEFAULT_PAGE_SIZE（20）条、
 * 标签计数仍来自 listAllTags()、首启引导 / 新建弹层 / 语音设置全部保留。
 */
export function RecordListPage() {
  const [list, setList] = useState<ListRecordsResult>(EMPTY_LIST);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tag, setTag] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  /** P2b：置顶 / 合集 */
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [pinnedRecords, setPinnedRecords] = useState<RecordSummary[]>([]);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  /** 合集条：新建 / 重命名 / ⋯ 菜单 / 删除二次确认 */
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newCollectionError, setNewCollectionError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [chipMenuOpen, setChipMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** 卡片 ⋯ 菜单（加入 / 移出合集） */
  const [menuRecordId, setMenuRecordId] = useState<string | null>(null);

  /** 拖拽状态（只有合集视图会写） */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  /** 「全部」chip 上的计数：只在无筛选的查询里取值，避免筛了标签后总数变小 */
  const [allTotal, setAllTotal] = useState<number | null>(null);

  /**
   * 今天新增的条数（P0.5）。`null` = 还没读到 —— 不要先渲染成 0，
   * 否则首屏会闪一下「今天 0 条」，那就是一个假数。
   */
  const [todayCount, setTodayCount] = useState<number | null>(null);

  const [creating, setCreating] = useState(false);
  /** P5：示例载入中（按钮禁用，避免连点） */
  const [examplesBusy, setExamplesBusy] = useState(false);

  const [voice, setVoice] = useState<VoiceSettings | null | undefined>(undefined);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1) 先读置顶 / 合集，并顺手清掉悬空 id（记录被删后的残留）
      const libraryNow = await pruneMissing();
      setLibrary(libraryNow);

      // 2) 选中的合集会话可能已经被删掉（另一个页面删的 / 导入覆盖）→ 回落到「全部」
      const active = findCollection(libraryNow, activeCollectionId);
      if (activeCollectionId && !active) setActiveCollectionId(null);

      // 3) 组合筛选：先合集（若有）→ 再标签 → 再搜索 → 再分页（在 query 层落地）
      const [result, pinnedRows, tagCounts, today, quotaNow] = await Promise.all([
        active
          ? listRecordsInOrder(active.recordIds, {
              tag: tag || undefined,
              search: search || undefined,
              page,
              pageSize: DEFAULT_PAGE_SIZE,
            })
          : listRecords({
              tag: tag || undefined,
              search: search || undefined,
              page,
              pageSize: DEFAULT_PAGE_SIZE,
              // 置顶的在上面单独一块，全部区不再重复显示
              excludeIds: libraryNow.pins,
            }),
        listRecordsByIds(libraryNow.pins, {
          tag: tag || undefined,
          search: search || undefined,
        }),
        listAllTags(),
        // 「今天 N 条」是全库口径（不受标签/搜索/合集筛选影响）
        countSince(startOfToday()),
        estimateQuota(),
      ]);

      setList(result);
      setPinnedRecords(pinnedRows);
      setTags(tagCounts);
      setTodayCount(today);
      setQuota(quotaNow);
      // 标题的「共 N 条」是全库口径：全部区会排除置顶，用 result.total 会少算
      if (!tag && !search) setAllTotal(await countRecords());
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [tag, search, page, activeCollectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 挂载即回到顶部（P1.5 §3）。
   *
   * 从详情页 / 设置页点「首页」回来时，文档的滚动位置会被浏览器留在原处，
   * 于是看起来「点了没动」。这里在挂载时滚一次 —— 只滚一次，
   * 筛选、翻页不换路由元素，不会被这个 effect 打断（它们本来也不该跳回顶部）。
   */
  useEffect(() => {
    scrollToTop();
  }, []);

  useEffect(() => {
    let cancelled = false;
    getVoiceSettings()
      .then((settings) => {
        if (!cancelled) setVoice(settings);
      })
      .catch(() => {
        if (!cancelled) setVoice(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 搜索防抖：300ms 后再打库，避免每敲一个字就查一次。
  //
  // 首次挂载必须跳过：否则挂载时会排一个 300ms 定时器把页码重置成 1，
  // 用户在这 300ms 内点「下一页」就会被它打回第一页（表现为"点了没反应"）。
  // 挂载时的首次加载由下面的 load() effect 负责，这里不需要重复。
  const skipInitialSearchEffect = useRef(true);
  useEffect(() => {
    if (skipInitialSearchEffect.current) {
      skipInitialSearchEffect.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  /* ---------------- 置顶 / 合集的动作（都会重新读库并刷新列表） ---------------- */

  /** 统一出口：动作失败只提示，不让异常冒到 React（冒上去整页白屏） */
  const runLibraryAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setLibraryBusy(true);
      setLibraryError(null);
      try {
        await action();
        await load();
      } catch (caught) {
        setLibraryError(describeError(caught));
      } finally {
        setLibraryBusy(false);
      }
    },
    [load],
  );

  function togglePin(recordId: string, nextPinned: boolean) {
    void runLibraryAction(() => setPinned(recordId, nextPinned));
  }

  function toggleCollection(id: string) {
    setChipMenuOpen(false);
    setConfirmDelete(false);
    setRenamingId(null);
    setActiveCollectionId((current) => (current === id ? null : id));
    setPage(1);
  }

  function exitCollection() {
    setActiveCollectionId(null);
    setChipMenuOpen(false);
    setConfirmDelete(false);
    setRenamingId(null);
    setPage(1);
  }

  async function submitNewCollection() {
    const name = newCollectionName.trim();
    if (!name) {
      setNewCollectionError('合集名不能为空');
      return;
    }
    setLibraryBusy(true);
    setNewCollectionError(null);
    try {
      await createCollection(name);
      setNewCollectionName('');
      setNewCollectionOpen(false);
      await load();
    } catch (caught) {
      setNewCollectionError(describeError(caught));
    } finally {
      setLibraryBusy(false);
    }
  }

  function startRename(collection: Collection) {
    setRenamingId(collection.id);
    setRenameValue(collection.name);
    setRenameError(null);
    setChipMenuOpen(false);
  }

  async function submitRename() {
    if (!renamingId) return;
    const name = renameValue.trim();
    if (!name) {
      setRenameError('合集名不能为空');
      return;
    }
    setLibraryBusy(true);
    setRenameError(null);
    try {
      await renameCollection(renamingId, name);
      setRenamingId(null);
      setRenameValue('');
      await load();
    } catch (caught) {
      setRenameError(describeError(caught));
    } finally {
      setLibraryBusy(false);
    }
  }

  async function removeCollection(id: string) {
    setConfirmDelete(false);
    setChipMenuOpen(false);
    if (activeCollectionId === id) setActiveCollectionId(null);
    await runLibraryAction(() => deleteCollection(id));
  }

  /**
   * 拖拽落下：把被拖的记录移动到目标记录的位置（`recordIds` 里的下标）。
   *
   * 越界 / 拖到自己身上在数据层也会被判为「原样返回」，这里先挡一层避免无谓写库。
   */
  function handleDrop(event: React.DragEvent<HTMLLIElement>, targetId: string) {
    if (!activeCollection || !dragId) return;
    event.preventDefault();
    const fromIndex = activeCollection.recordIds.indexOf(dragId);
    const toIndex = activeCollection.recordIds.indexOf(targetId);
    setDragId(null);
    setDropId(null);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    void runLibraryAction(() => reorderCollection(activeCollection.id, fromIndex, toIndex));
  }

  /**
   * P5 §7：载入三条示例（真记录，写进库）。
   *
   * 幂等在数据层（固定 id + put 覆盖），这里只负责「载入 → 重新读库 → 提示」。
   * 只在整库为空时给入口 —— 有记录的人不需要被塞示例。
   */
  async function handleLoadExamples() {
    setExamplesBusy(true);
    setError(null);
    try {
      const result = await loadExampleRecords();
      setNotice(
        result.overwritten
          ? '示例已重新载入（覆盖了同一组示例，没有多出新记录）'
          : '已载入 3 条示例：笔记 → AI 产出 → 成品，成品下面能看到它的来源',
      );
      setPage(1);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setExamplesBusy(false);
    }
  }

  async function handleChooseVoice(mode: VoiceMode) {
    setVoiceBusy(true);
    setVoiceError(null);
    try {
      const saved = await saveVoiceSettings({ mode });
      setVoice(saved);
      setNotice(
        mode === 'cloud-stt'
          ? '已选「云端 STT」：请到「设置 → 语音」填写 base_url / key / model（M3 不会在保存时发请求）。'
          : mode === 'local-whisper'
            ? '已选「本地模型」：完全离线、不花钱，模型随应用发布（可在「设置 → 语音」里改）。'
            : '已选「仅录音备忘」，可随时在「设置」里改。',
      );
    } catch (caught) {
      setVoiceError(describeError(caught));
    } finally {
      setVoiceBusy(false);
    }
  }

  const activeVoiceLabel =
    voice === undefined ? '读取中…' : voice ? VOICE_MODE_LABELS[voice.mode] : '尚未选择';
  const totalShown = allTotal ?? list.total;
  // 首屏还没读到数据时不要显示「共 0 条」，那会被读成「一条都没有」
  const totalLabel = allTotal === null ? '…' : `${totalShown}`;

  const activeCollection = findCollection(library, activeCollectionId);
  /** 拖拽只在合集视图可用；「全部」视图里连 draggable 属性都不渲染 */
  const canDrag = Boolean(activeCollection);

  /**
   * 卡片 ⋯ 菜单内容：置顶卡与普通卡共用一份。
   *
   * 为什么要给置顶卡也挂这个菜单：置顶的记录已经从「全部」移走了，
   * 如果只有「全部」里的卡能加合集，那它一旦被置顶就再也进不了任何合集 ——
   * 这是真的功能死路（样张上置顶卡只有 📌，这里多一个 ⋯，报告的差异节有记）。
   */
  function renderCollectionMenu(recordId: string) {
    return (
      <span className="record-menu" role="group" aria-label="加入合集">
        <span className="record-menu-title">加入合集</span>
        {library.collections.length === 0 ? (
          <span className="record-menu-empty">还没有合集。先在「合集」那一行新建一个。</span>
        ) : (
          <span className="record-menu-list">
            {library.collections.map((collection) => {
              const inCollection = collection.recordIds.includes(recordId);
              return (
                <label className="record-menu-item" key={collection.id}>
                  <input
                    type="checkbox"
                    checked={inCollection}
                    aria-label={`${inCollection ? '移出' : '加入'}合集「${collection.name}」`}
                    onChange={() => {
                      void runLibraryAction(() =>
                        inCollection
                          ? removeFromCollection(collection.id, recordId)
                          : addToCollection(collection.id, recordId),
                      );
                    }}
                  />
                  <span>{collection.name}</span>
                </label>
              );
            })}
          </span>
        )}
        <button type="button" className="record-menu-close" onClick={() => setMenuRecordId(null)}>
          关闭
        </button>
      </span>
    );
  }

  return (
    <section className="page page-records">
      <header className="records-head">
        <h2 className="records-title">记录列表</h2>
        <span className="records-total">
          共 {totalLabel} 条
          {/* 今天 0 条不显示（样张也只写「共 N 条」）；读到之前是 null，也不显示，避免闪一个假的 0 */}
          {todayCount !== null && todayCount > 0 ? ` · 今天 ${todayCount} 条` : ''}
        </span>
        <p className="records-voice">当前语音方式：{activeVoiceLabel}（在「设置」里可改）</p>
        <button
          type="button"
          className="button primary records-new"
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? '收起' : '+ 新建记录'}
        </button>
      </header>

      {voice === null && (
        <OnboardingPanel onChosen={handleChooseVoice} busy={voiceBusy} error={voiceError} />
      )}

      {creating && (
        <RecordEditor
          onSaved={() => {
            setCreating(false);
            setPage(1);
            setNotice('记录已保存。');
            void load();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {/* 搜索与标签同排：搜索框弹性、最多 420px，标签 chip 紧随其后 */}
      <div className="records-tools">
        <input
          type="search"
          className="search-input"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="搜索正文或标签…"
          aria-label="搜索记录"
        />
        {tags.length > 0 && (
          <div className="tag-filter records-chips" role="group" aria-label="标签筛选">
            <button
              type="button"
              className={`chip${tag === '' ? ' on' : ''}`}
              aria-pressed={tag === ''}
              onClick={() => {
                setTag('');
                setPage(1);
              }}
            >
              全部<span className="chip-count">{totalShown}</span>
            </button>
            {tags.map((item) => (
              <button
                key={item.tag}
                type="button"
                className={`chip${tag === item.tag ? ' on' : ''}`}
                aria-pressed={tag === item.tag}
                onClick={() => {
                  setTag((current) => (current === item.tag ? '' : item.tag));
                  setPage(1);
                }}
              >
                #{item.tag}
                <span className="chip-count">{item.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 合集条（任务书 §2.1 第三层） */}
      <div className="records-collections" role="group" aria-label="合集">
        <span className="collections-label">合集</span>
        {library.collections.map((collection) => {
          const on = collection.id === activeCollectionId;
          return (
            <span className="collection-slot" key={collection.id}>
              {renamingId === collection.id ? (
                <form
                  className="collection-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitRename();
                  }}
                >
                  <input
                    // 行内重命名：立刻可输入（不是自动聚焦的弹层）
                    autoFocus
                    className="collection-input"
                    value={renameValue}
                    maxLength={40}
                    aria-label="合集名"
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setRenamingId(null);
                        setRenameError(null);
                      }
                    }}
                  />
                  <button type="submit" className="collection-form-button" disabled={libraryBusy}>
                    保存
                  </button>
                  <button
                    type="button"
                    className="collection-form-button ghost"
                    onClick={() => {
                      setRenamingId(null);
                      setRenameError(null);
                    }}
                  >
                    取消
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className={`collection-chip${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleCollection(collection.id)}
                >
                  {collection.name}
                  <span className="chip-count">{collection.recordIds.length}</span>
                </button>
              )}
              {on && renamingId !== collection.id && (
                <button
                  type="button"
                  className="collection-more"
                  aria-label="合集操作"
                  aria-expanded={chipMenuOpen}
                  onClick={() => {
                    setChipMenuOpen((value) => !value);
                    setConfirmDelete(false);
                  }}
                >
                  ⋯
                </button>
              )}
              {on && chipMenuOpen && renamingId !== collection.id && (
                <span className="collection-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="collection-menu-item"
                    onClick={() => startRename(collection)}
                  >
                    重命名
                  </button>
                  {confirmDelete ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="collection-menu-item danger"
                      onClick={() => void removeCollection(collection.id)}
                    >
                      确认删除「{collection.name}」？
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className="collection-menu-item"
                      onClick={() => setConfirmDelete(true)}
                    >
                      删除合集
                    </button>
                  )}
                </span>
              )}
            </span>
          );
        })}

        {newCollectionOpen ? (
          <form
            className="collection-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitNewCollection();
            }}
          >
            <input
              // 行内新建：立刻可输入
              autoFocus
              className="collection-input"
              value={newCollectionName}
              maxLength={40}
              placeholder="合集名"
              aria-label="新合集名"
              onChange={(event) => setNewCollectionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setNewCollectionOpen(false);
                  setNewCollectionName('');
                  setNewCollectionError(null);
                }
              }}
            />
            <button type="submit" className="collection-form-button" disabled={libraryBusy}>
              创建
            </button>
            <button
              type="button"
              className="collection-form-button ghost"
              onClick={() => {
                setNewCollectionOpen(false);
                setNewCollectionName('');
                setNewCollectionError(null);
              }}
            >
              取消
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="collection-add"
            onClick={() => {
              setNewCollectionOpen(true);
              setNewCollectionError(null);
            }}
          >
            ＋ 新建合集
          </button>
        )}
      </div>

      {newCollectionError && <p className="error library-error">{newCollectionError}</p>}
      {renameError && <p className="error library-error">{renameError}</p>}
      {libraryError && <p className="error library-error">{libraryError}</p>}

      {/* 置顶区：只在「全部」视图、且真有置顶时渲染（没有就不留空标题） */}
      {!activeCollection && pinnedRecords.length > 0 && (
        <section className="pinned-section" aria-label="置顶">
          <div className="library-section-head">
            <h3 className="library-section-title">置顶</h3>
            <span className="library-section-line" aria-hidden="true" />
          </div>
          <ul className="pinned-grid">
            {pinnedRecords.map((item) => (
              <li key={item.id} className="pinned-card">
                <Link to={`/records/${item.id}`} className="pinned-link">
                  <span className="pinned-text">{item.text || '（无文字，仅录音）'}</span>
                  <span className="pinned-meta">
                    {item.tags.slice(0, 1).map((itemTag) => (
                      <span key={itemTag} className="pinned-tag">
                        #{itemTag}
                      </span>
                    ))}
                    <span className="pinned-stamp">{formatDateTime(item.createdAt)}</span>
                  </span>
                </Link>
                <button
                  type="button"
                  className="pin-toggle"
                  aria-label="取消置顶"
                  aria-pressed
                  onClick={() => togglePin(item.id, false)}
                >
                  📌
                </button>
                <button
                  type="button"
                  className="pinned-more"
                  aria-label="更多操作"
                  aria-expanded={menuRecordId === item.id}
                  onClick={() => setMenuRecordId((current) => (current === item.id ? null : item.id))}
                >
                  ⋯
                </button>
                {menuRecordId === item.id && renderCollectionMenu(item.id)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="error records-error">{error}</p>}
      {notice && <p className="success">{notice}</p>}

      {/* 区块标题：全部（时间倒序）/ 合集名（可拖拽） */}
      <div className="library-section-head">
        {activeCollection && (
          <button type="button" className="section-back" onClick={exitCollection}>
            ← 全部
          </button>
        )}
        <h3 className="library-section-title">
          {activeCollection ? activeCollection.name : '全部'}
          {/*
            P3 §4：标题带数量（「全部 7」）。数字 = 这个区块**实际有几条**（置顶已排除），
            这样「共 8 条」= 「置顶 1」+「全部 7」，用户不用自己掰手指对账。
            读到之前 / 读失败时不渲染数字 —— 闪一个假的 0 比不显示更糟。
            `{' '}` 是给读屏与复制留的空格（视觉上靠 margin 分开就够了）。
          */}
          {!activeCollection && !loading && !error && (
            <>
              {' '}
              {/*
                差额的解释放在 title 里，而不是可见文案：可见文案不能出现「置顶」二字 ——
                `record-list-library.test.tsx` 有一条「没有置顶时整页不该出现『置顶』」的断言
                （不许留空标题），而这一行在无置顶时也要渲染。悬停仍能读到口径说明。
              */}
              <span
                className="library-section-count"
                title="置顶的记录在上面单独一块，这里不重复计数"
              >
                {list.total}
              </span>
            </>
          )}
        </h3>
        <span className="library-section-line" aria-hidden="true" />
        <span className="library-section-note">
          {activeCollection ? '拖拽可调整顺序' : '按时间倒序'}
        </span>
      </div>

      {/* 读失败 ≠ 空列表：error 时不再渲染空态文案，否则「读取失败」会被读成「数据没了」 */}
      {loading ? (
        <div className="records-loading" role="status">
          <p className="records-state-text">正在读取本地记录…</p>
          <div className="record-list records-skeleton" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <div key={key} className="record-item skeleton-card">
                <span className="skeleton-line" />
                <span className="skeleton-line skeleton-line-short" />
                <span className="skeleton-meta" />
              </div>
            ))}
          </div>
        </div>
      ) : error && list.items.length === 0 ? null : list.items.length === 0 ? (
        <div className="records-empty">
          <p className="records-empty-mark" aria-hidden="true">
            ✦
          </p>
          <p className="records-empty-text">
            {activeCollection
              ? tag || search
                ? '这个合集里没有符合条件的记录。'
                : '这个合集还没有记录。用卡片右上角「⋯」把记录加进来。'
              : tag || search
                ? '没有符合条件的记录。'
                : '还没有记录。点「+ 新建记录」写下第一个梦。'}
          </p>
          {/*
            P5 §7.1：整库为空时才给这两个入口（有记录的人不需要被塞示例）。
            「载入一组示例」写的是**真记录**：三条，覆盖笔记 / AI 产出 / 成品，
            最后那条带来源 —— 用户一进来就能看见主次关系长什么样，也能直接改。
          */}
          {!activeCollection && !tag && !search && allTotal === 0 && (
            <div className="records-empty-actions">
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setCreating(true);
                  setNotice(null);
                }}
              >
                ＋ 新建记录
              </button>
              <button
                type="button"
                className="button ghost"
                data-load-examples
                disabled={examplesBusy}
                onClick={() => void handleLoadExamples()}
              >
                {examplesBusy ? '载入中…' : '载入一组示例'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <ul
          className="record-list"
          data-view={activeCollection ? 'collection' : 'all'}
          aria-label={activeCollection ? `${activeCollection.name}（合集）` : '全部记录'}
        >
          {list.items.map((item) => {
            const pinnedHere = library.pins.includes(item.id);
            const dragging = dragId === item.id;
            const isDropTarget = dropId === item.id && dragId !== null && dragId !== item.id;
            // P5：角色与来源（缺省 = 笔记 / 无来源，旧记录照样读）
            const role = normalizeRole(item.role);
            const sourceCount = (item.sourceIds ?? []).length;
            const copyItem = isCopyLike(item.role, item.sourceIds);
            return (
              <li
                key={item.id}
                data-record-role={role}
                className={[
                  'record-item',
                  canDrag ? 'record-item-draggable' : '',
                  dragging ? 'dragging' : '',
                  isDropTarget ? 'drop-target' : '',
                  menuRecordId === item.id ? 'menu-open' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                {...(canDrag
                  ? {
                      draggable: true,
                      onDragStart: (event: React.DragEvent<HTMLLIElement>) => {
                        setDragId(item.id);
                        event.dataTransfer?.setData('text/plain', item.id);
                        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                      },
                      onDragOver: (event: React.DragEvent<HTMLLIElement>) => {
                        if (!dragId) return;
                        // 不 preventDefault 就不允许落位（这是 HTML5 拖拽的规定动作）
                        event.preventDefault();
                        setDropId(item.id);
                      },
                      onDragLeave: () => {
                        setDropId((current) => (current === item.id ? null : current));
                      },
                      onDrop: (event: React.DragEvent<HTMLLIElement>) => handleDrop(event, item.id),
                      onDragEnd: () => {
                        setDragId(null);
                        setDropId(null);
                      },
                    }
                  : {})}
              >
                <Link to={`/records/${item.id}`} className="record-link">
                  {/* P5 §4.1：成品的左上角角标（accent-soft 底）；普通笔记什么都不加 */}
                  {role === 'draft' && (
                    <span className="record-role-badge" data-record-role-badge="draft">
                      成品
                    </span>
                  )}
                  <span className="record-text">{item.text || '（无文字，仅录音）'}</span>
                  <span className="record-meta">
                    {copyItem && (
                      <span className="record-badge record-badge-copy" data-record-role-badge="copy">
                        副本
                      </span>
                    )}
                    {item.tags.map((itemTag) => (
                      <span key={itemTag} className="record-tag">
                        #{itemTag}
                      </span>
                    ))}
                    {item.hasAudio && (
                      <span className="record-badge">♫ {formatDuration(item.audioDurationMs ?? 0)}</span>
                    )}
                    {item.hasAIResult === true && <span className="record-badge">✦ 已有解梦</span>}
                    {/* P5 §4.1：成品才有这一行；来源为 0 时不显示空话 */}
                    {role === 'draft' && sourceCount > 0 && (
                      <span className="record-source" data-record-source-count={sourceCount}>
                        来自 {sourceCount} 条素材
                      </span>
                    )}
                    <span className="record-stamp">{formatDateTime(item.createdAt)}</span>
                  </span>
                </Link>

                {canDrag && (
                  <span className="drag-handle" aria-hidden="true">
                    ⠿
                  </span>
                )}
                <button
                  type="button"
                  className={`record-pin${pinnedHere ? ' on' : ''}`}
                  aria-label={pinnedHere ? '取消置顶' : '置顶这条记录'}
                  aria-pressed={pinnedHere}
                  onClick={() => togglePin(item.id, !pinnedHere)}
                >
                  📌
                </button>
                <button
                  type="button"
                  className="record-more"
                  aria-label="更多操作"
                  aria-expanded={menuRecordId === item.id}
                  onClick={() => setMenuRecordId((current) => (current === item.id ? null : item.id))}
                >
                  ⋯
                </button>

                {menuRecordId === item.id && renderCollectionMenu(item.id)}
              </li>
            );
          })}
        </ul>
      )}

      <footer className="records-foot">
        <p className="records-usage">
          {quota ? (
            <>
              <strong>{formatBytes(quota.usage)}</strong> / {formatBytes(quota.quota)} · 数据只在这台设备上
            </>
          ) : loading ? (
            '正在统计存储占用…'
          ) : error ? (
            '存储占用暂时读不到'
          ) : (
            '当前环境无法查询配额（浏览器未提供 Quota API），写入仍会照常进行。'
          )}
        </p>
        <a className="records-backup" href="#/settings">
          备份与导入：设置 → 导入导出
        </a>
        <div className="records-pager">
          <button
            type="button"
            className="pager-button"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            disabled={list.page <= 1}
          >
            上一页
          </button>
          <span className="pager-info">
            第 {list.page} / {Math.max(list.pageCount, 1)} 页
          </span>
          <button
            type="button"
            className="pager-button"
            onClick={() => setPage((value) => value + 1)}
            disabled={list.pageCount === 0 || list.page >= list.pageCount}
          >
            下一页
          </button>
        </div>
      </footer>
    </section>
  );
}
