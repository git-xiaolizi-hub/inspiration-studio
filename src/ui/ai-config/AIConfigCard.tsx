/**
 * 设置页「AI 配置」卡（R7b §A）。
 *
 * 三块入口 + 一行已配置模型标签，**卡片定高 290px**：
 * 0 个模型和 10 个模型时高度必须完全一致（`getBoundingClientRect().height`），
 * 否则四张设置卡会高低不齐（委托人 R6 的原话：「四张卡不会因为模型多少而高低不齐」）。
 *
 * 标签最多铺两行，超出的折成「还有 N 个 ›」（点它和点「详情」等价）。
 * **能铺几个是量出来的，不是写死的 6**（R7b 修复）：卡片宽度不够时两行放不下 6 个，
 * 旧实现按固定值切片 + CSS 裁切，会把第 5、6 个静默吃掉 ——
 * 表现就是标题写「已配置 5 个模型」但只看到 4 个，也不告诉你还有第 5 个。
 *
 * `×` 的语义 = **从这条连接的模型表里移除该行**（不是 `enabled=false`，不是删连接）。
 * 若被删的模型正被某个角色当默认，同时清掉那个角色指针（不留悬空）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MODEL_ROLES,
  loadCatalog,
  removeModel,
  saveCatalog,
} from '../../adapters/ai-models/catalog';
import type { AICatalog, ModelRoles } from '../../adapters/ai-models/catalog';
import {
  orderModels,
  readModelOrder,
  readModelRoles,
  writeModelOrder,
  writeModelRoles,
} from '../../adapters/ai-models/model-prefs';
import { describeError } from '../format';
import { configuredModels, modelLabel } from './configured-models';
import type { ConfiguredModel } from './configured-models';
import { AI_CONFIG_CARD_MAX_FLAT } from './detail-order';
import { AIDetailDialog } from './AIDetailDialog';
import { RecommendDialog } from './RecommendDialog';

/** 标签行的行间距兜底值（与 styles.css 的 .ai-card-chips gap 一致；优先读计算样式） */
const CHIP_GAP_PX = 7;

export function AIConfigCard() {
  const [catalog, setCatalog] = useState<AICatalog | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [roles, setRoles] = useState<ModelRoles>({});
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const [loadedCatalog, loadedOrder, loadedRoles] = await Promise.all([
      loadCatalog(),
      readModelOrder(),
      readModelRoles(),
    ]);
    setCatalog(loadedCatalog);
    setOrder(loadedOrder);
    setRoles(loadedRoles);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await reload();
      } catch (caught) {
        if (!cancelled) setError(describeError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  /** 卡片与详情弹窗共用这一份「已排序的已配置模型」 */
  /** 全部（含未生效连接里的）→ 给详情弹窗；卡片只显示生效连接里能用的那些 */
  const allRows = useMemo(
    () => (catalog ? orderModels(configuredModels(catalog), order) : []),
    [catalog, order],
  );
  const rows = useMemo(() => allRows.filter((row) => row.active), [allRows]);
  const inactiveCount = allRows.length - rows.length;

  /**
   * 删一行（卡片与详情弹窗共用）：
   * ① 从连接的模型表里删掉这一行；② 清掉指向它的角色指针；③ 顺手从 modelOrder 里摘掉。
   */
  const handleRemove = useCallback(
    async (row: ConfiguredModel): Promise<void> => {
      if (!catalog) return;
      try {
        const saved = await saveCatalog(removeModel(catalog, row.providerId, row.modelRowId));
        const nextOrder = order.filter((key) => key !== row.key);
        if (nextOrder.length !== order.length) await writeModelOrder(nextOrder);

        const nextRoles: ModelRoles = { ...roles };
        let rolesChanged = false;
        for (const role of MODEL_ROLES) {
          if (nextRoles[role] === row.key) {
            delete nextRoles[role];
            rolesChanged = true;
          }
        }
        if (rolesChanged) await writeModelRoles(nextRoles);

        setCatalog(saved);
        setOrder(nextOrder);
        setRoles(nextRoles);
        setError(null);
      } catch (caught) {
        setError(describeError(caught));
      }
    },
    [catalog, order, roles],
  );

  /** 角色改动即时写库（不需要「保存」按钮） */
  const handleChangeRole = useCallback(
    async (role: keyof ModelRoles, key: string): Promise<void> => {
      const next: ModelRoles = { ...roles };
      if (key === '') delete next[role];
      else next[role] = key;
      setRoles(next);
      try {
        await writeModelRoles(next);
      } catch (caught) {
        setError(describeError(caught));
      }
    },
    [roles],
  );

  /** 排序结果即时写库，并立刻反映到卡片标签顺序上 */
  const handleReorder = useCallback(async (nextOrder: string[]): Promise<void> => {
    setOrder(nextOrder);
    try {
      await writeModelOrder(nextOrder);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  const total = rows.length;

  /**
   * 两行实际能放下几个标签 —— 隐藏层里按真实宽度排一遍再数。
   * 量不出来（jsdom、标签未布局）就退回 MAX_FLAT，测试因此仍然可预期。
   */
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const [flatCount, setFlatCount] = useState(AI_CONFIG_CARD_MAX_FLAT);

  useLayoutEffect(() => {
    const box = chipsRef.current;
    if (!box) return;
    const measure = (): void => {
      const layer = box.querySelector<HTMLElement>('[data-chip-measure-layer]');
      const chips = layer ? Array.from(layer.querySelectorAll<HTMLElement>('[data-chip-measure]')) : [];
      const first = chips[0];
      if (!first || first.offsetHeight === 0) return; // 未布局：保持兜底值
      const gap = Number.parseFloat(getComputedStyle(layer as HTMLElement).rowGap) || CHIP_GAP_PX;
      const rowHeight = first.offsetHeight + gap;
      // 卡片是定高的：能铺几行由「还剩多少高度」决定，而不是写死两行
      const card = box.closest('.card-ai') as HTMLElement | null;
      const boxRect = box.getBoundingClientRect();
      const paddingBottom = card ? Number.parseFloat(getComputedStyle(card).paddingBottom) || 0 : 0;
      const available = card ? card.getBoundingClientRect().bottom - boxRect.top - paddingBottom : 0;
      const rows = Math.max(1, Math.floor((available + gap) / rowHeight));
      let fits = chips.filter((chip) => chip.offsetTop < rowHeight * rows - 1).length;
      // 有折叠时给「还有 N 个」留一个位置
      if (fits < chips.length) fits -= 1;
      setFlatCount(Math.max(1, Math.min(chips.length, fits)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [rows]);

  const flat = rows.slice(0, flatCount);
  const folded = total - flat.length;

  return (
    <section className="card card-ai" data-block="model-vendors">
      <h3>AI 配置</h3>
      <p className="settings-block-sub">配置 AI 连接、选择模型、查看价格</p>

      <div className="ai-card-actions">
        <button
          type="button"
          className="button primary"
          data-testid="ai-card-recommend"
          onClick={() => {
            setNotice(null);
            setRecommendOpen(true);
          }}
        >
          推荐配置
        </button>
        <Link className="button ghost" to="/ai-config">
          自由配置
        </Link>
        <Link className="button ghost" to="/model-guide">
          选型指南
        </Link>
      </div>

      <div className="ai-card-chips-label">
        <span>
          {total === 0 ? '还没有配置任何模型' : `已配置 ${total} 个模型`}
          {inactiveCount > 0 ? `（另有 ${inactiveCount} 个在未生效的连接里）` : ''}
        </span>
        <span className="ai-card-rule" aria-hidden="true" />
        <button
          type="button"
          className="button ghost ai-card-detail"
          data-testid="ai-card-detail"
          disabled={total === 0}
          onClick={() => {
            setNotice(null);
            setDetailOpen(true);
          }}
        >
          详情
        </button>
      </div>

      {total === 0 ? (
        <div className="ai-card-empty">
          写作、生图、生视频都还没有可用的模型。<b>点「推荐配置」</b>
          会自动填好三组最常见的连接，你只需要补三个 Key；也可以点「自由配置」自己一条条填。
        </div>
      ) : (
        <div className="ai-card-chips" ref={chipsRef}>
          {/* 隐藏测量层：按真实宽度排一遍，用来数「两行到底放得下几个」（不参与布局、不进读屏） */}
          <div className="ai-chip-measure-layer" data-chip-measure-layer aria-hidden="true">
            {rows.map((row) => (
              <span className="ai-chip-token" data-chip-measure key={row.key}>
                <span className="ai-chip-model">{modelLabel(row)}</span>
                <span className="ai-chip-vendor">· {row.providerName}</span>
                <span className="ai-chip-x" aria-hidden="true">
                  ×
                </span>
              </span>
            ))}
          </div>
          {flat.map((row) => (
            <span className="ai-chip" key={row.key} data-model-key={row.key}>
              <span className="ai-chip-model">{modelLabel(row)}</span>
              <span className="ai-chip-vendor">· {row.providerName}</span>
              <button
                type="button"
                className="ai-chip-x"
                aria-label={`移除 ${modelLabel(row)}`}
                title="取消配置这个模型（不删连接与 Key）"
                onClick={() => void handleRemove(row)}
              >
                ×
              </button>
            </span>
          ))}
          {folded > 0 && (
            <button
              type="button"
              className="ai-chip ai-chip-more"
              onClick={() => {
                setNotice(null);
                setDetailOpen(true);
              }}
            >
              还有 {folded} 个 ›
            </button>
          )}
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      {/* 保存结果这类即时反馈要留着；静态的使用说明是写给自己的草稿，委托人要求删掉 */}
      {notice && <p className="ai-card-note is-success">{notice}</p>}

      <RecommendDialog
        open={recommendOpen}
        onClose={() => setRecommendOpen(false)}
        onSaved={async (message) => {
          setRecommendOpen(false);
          setNotice(message);
          await reload();
        }}
      />

      <AIDetailDialog
        open={detailOpen}
        rows={allRows}
        catalog={catalog}
        roles={roles}
        onDismiss={() => setDetailOpen(false)}
        onChangeRole={(role, key) => void handleChangeRole(role, key)}
        onReorder={(nextOrder) => void handleReorder(nextOrder)}
        onRemove={(row) => void handleRemove(row)}
      />
    </section>
  );
}
