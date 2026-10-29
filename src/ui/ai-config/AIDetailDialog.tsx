/**
 * 「详情」弹窗（R7b §C）：五个角色的默认模型 + 全部已配置模型（徽标 + 排序 + 删除）。
 *
 * 两件事互不影响：
 * - 上面选「生成时默认用哪个」（写 `settings.modelRoles`）；
 * - 下面调「卡片上的显示顺序」（写 `settings.modelOrder`）。
 *
 * 排序为什么两种方式都做：HTML5 drag 在**触屏上根本不触发**（用户提过，
 * 任务书 §C.3 也点名了），所以每行另配 `↑` `↓` 两个按钮做兜底 —— 触屏与键盘都能用。
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CAP_LABELS,
  MODEL_CAPS,
  MODEL_ROLES,
  ROLE_CAP,
  ROLE_LABELS,
  listModelsByCap,
  modelKeyOf,
} from '../../adapters/ai-models/catalog';
import type { AICatalog, ModelCap, ModelRole, ModelRoles } from '../../adapters/ai-models/catalog';
import { Dialog } from '../components/Dialog';
import { AGENT_ROLE_HINT, moveModelKey, nudgeModelKey } from './detail-order';
import { modelLabel } from './configured-models';
import type { ConfiguredModel } from './configured-models';

interface RoleCandidate {
  key: string;
  label: string;
}

/**
 * 某个角色的候选集 = 该能力的模型（`listModelsByCap`，口径与生成时一致）。
 * key 需要连接 id，所以从「该厂商当前生效的连接」补上。
 */
function candidatesFor(catalog: AICatalog | null, cap: ModelCap): RoleCandidate[] {
  if (!catalog) return [];
  const result: RoleCandidate[] = [];
  for (const ref of listModelsByCap(catalog, cap)) {
    result.push({
      key: modelKeyOf(ref.providerId, ref.connectionId, ref.modelId),
      label: `${ref.displayName || ref.modelId} · ${ref.providerName}`,
    });
  }
  return result;
}

interface Props {
  open: boolean;
  rows: ConfiguredModel[];
  catalog: AICatalog | null;
  roles: ModelRoles;
  onDismiss: () => void;
  onChangeRole: (role: ModelRole, key: string) => void;
  onReorder: (order: string[]) => void;
  onRemove: (row: ConfiguredModel) => void;
}

export function AIDetailDialog({
  open,
  rows,
  catalog,
  roles,
  onDismiss,
  onChangeRole,
  onReorder,
  onRemove,
}: Props) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  /** 落点：`{ key, after }` —— 空 = 没有在拖动 */
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean } | null>(null);

  const keys = useMemo(() => rows.map((row) => row.key), [rows]);

  function applyOrder(next: string[]): void {
    if (next.length !== keys.length) return;
    if (next.every((key, index) => key === keys[index])) return;
    onReorder(next);
  }

  function handleDrop(): void {
    if (dragKey && dropAt) applyOrder(moveModelKey(keys, dragKey, dropAt.key, dropAt.after));
    setDragKey(null);
    setDropAt(null);
  }

  return (
    <Dialog
      open={open}
      title={`已配置的模型 · ${rows.length} 个`}
      maxWidth={560}
      scrollBody
      bodyClassName="ai-detail-body"
      onDismiss={onDismiss}
      actions={[{ label: '完成', kind: 'primary', onClick: onDismiss }]}
    >
      <p className="modal-sub">上面选默认、下面调顺序，两件事互不影响。点右侧 × 只取消这一个模型的配置。</p>

      <p className="ai-roles-title">默认用哪个 —— 生成时按这里走；下面的列表只管卡片上的显示顺序</p>
      <div className="ai-roles">
        {MODEL_ROLES.map((role) => {
          const cap = ROLE_CAP[role];
          const candidates = candidatesFor(catalog, cap);
          const current = roles[role] ?? '';
          const known = candidates.some((item) => item.key === current);
          // 指针指向的模型已经不在了（或能力不匹配）：不伪造选项，按「未配置」显示
          const value = known ? current : '';
          return (
            <label className={`ai-role${role === 'agent' ? ' ai-role-wide' : ''}`} key={role}>
              <span className="ai-role-label">{ROLE_LABELS[role]}</span>
              <select
                aria-label={`默认${ROLE_LABELS[role]}模型`}
                className={value === '' ? 'is-empty' : undefined}
                value={value}
                onChange={(event) => onChangeRole(role, event.target.value)}
              >
                <option value="">
                  {candidates.length === 0 ? '未配置' : '未配置（自动）'}
                </option>
                {candidates.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <p className="ai-detail-hint">{AGENT_ROLE_HINT}</p>

      {rows.length === 0 ? (
        <div className="ai-detail-empty">
          还没有配置任何模型 —— <Link to="/ai-config">去 AI 配置页加一条</Link>
        </div>
      ) : (
        <div className="ai-detail-list" role="list" onDragEnd={handleDrop}>
          {rows.map((row, index) => {
            const dragging = dragKey === row.key;
            const showLineBefore =
              dropAt !== null && dropAt.key === row.key && !dropAt.after && dragKey !== row.key;
            const showLineAfter =
              dropAt !== null && dropAt.key === row.key && dropAt.after && dragKey !== row.key;
            return (
              <div key={row.key} className="ai-detail-row-wrap">
                {showLineBefore && <div className="ai-drop-line" aria-hidden="true" />}
                <div
                  role="listitem"
                  className={`ai-detail-row${dragging ? ' is-dragging' : ''}`}
                  data-model-key={row.key}
                  draggable
                  onDragStart={(event) => {
                    setDragKey(row.key);
                    setDropAt(null);
                    event.dataTransfer.effectAllowed = 'move';
                    // Firefox 要求 setData 才真正开始拖
                    event.dataTransfer.setData('text/plain', row.key);
                  }}
                  onDragOver={(event) => {
                    if (!dragKey || dragKey === row.key) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    const box = event.currentTarget.getBoundingClientRect();
                    setDropAt({ key: row.key, after: event.clientY > box.top + box.height / 2 });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleDrop();
                  }}
                >
                  <span className="ai-grip" aria-hidden="true">
                    ⋮⋮
                  </span>
                  <span className="ai-row-name" title={row.modelId}>
                    {modelLabel(row)}
                  </span>
                  <span className="ai-row-vendor">{row.providerName}</span>
                  <span className="ai-badges">
                    {MODEL_CAPS.filter((cap) => row.caps.includes(cap)).map((cap) => (
                      <span className={`ai-badge ai-badge-${cap}`} key={cap}>
                        {CAP_LABELS[cap]}
                      </span>
                    ))}
                  </span>
                  <span className="ai-row-move">
                    <button
                      type="button"
                      className="ai-row-btn"
                      aria-label={`上移 ${modelLabel(row)}`}
                      disabled={index === 0}
                      onClick={() => applyOrder(nudgeModelKey(keys, row.key, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ai-row-btn"
                      aria-label={`下移 ${modelLabel(row)}`}
                      disabled={index === rows.length - 1}
                      onClick={() => applyOrder(nudgeModelKey(keys, row.key, 1))}
                    >
                      ↓
                    </button>
                  </span>
                  <button
                    type="button"
                    className="ai-row-btn ai-row-remove"
                    aria-label={`移除 ${modelLabel(row)}`}
                    title="取消配置这个模型（不删连接与 Key）"
                    onClick={() => onRemove(row)}
                  >
                    ×
                  </button>
                </div>
                {showLineAfter && <div className="ai-drop-line" aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      )}

      <p className="ai-detail-hint">
        拖动左侧把手改顺序；触屏没有 HTML5 拖拽，用每行的 ↑ ↓ 按钮同样能挪（效果一致）。
      </p>
      <p className="ai-detail-hint">
        同一家站配了两把 Key 也没关系：每个模型都记着自己在哪把 Key 下，生成时自动用对的那把。
      </p>
    </Dialog>
  );
}
