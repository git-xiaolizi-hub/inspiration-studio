/**
 * 已选模型表（M3R $2，M3R4 $1 收列，M3R6 $3 改第一列）。
 *
 * 一行 = 一条模型，**多行可以同时启用**：
 * - 第一列是「启用」复选框（`ModelEntry.enabled`）——语义是「这条是否出现在可选列表里」，
 *   临时停用不必删行；缺省 = 启用。
 * - **没有「当前用哪个」的单选**：这次用哪个由生成时选（或 `pickModel` 按能力自动挑）。
 *   承接方第四次评审说得对：模型不该单选，模型表本来就是「能用的那一批」。
 *
 * 表头上方还有一句说明（在 AIConfigPanel 里，`data-testid="model-hint"`），
 * 免得用户把它当命令。
 *
 * 复制模型表（M3R6 $1.3）：同一家站加第二个 key 时不用把模型表重配一遍。
 */
import { useState } from 'react';
import { CAP_LABELS, MODEL_CAPS } from '../../adapters/ai-models/catalog';
import type { ModelCap, ModelEntry } from '../../adapters/ai-models/catalog';

export interface ModelTableProps {
  models: ModelEntry[];
  /** 可以把当前模型表复制过去的其他连接（0 条 → 不显示复制入口） */
  copyTargets?: Array<{ id: string; label: string }>;
  onCopy?: (targetConnectionId: string) => void;
  onUpdate: (id: string, patch: Partial<Omit<ModelEntry, 'id'>>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export function ModelTable({
  models,
  copyTargets = [],
  onCopy,
  onUpdate,
  onRemove,
  onAdd,
}: ModelTableProps) {
  const [copyTarget, setCopyTarget] = useState('');
  // 目标连接被删掉之后别留着一个不存在的 id（否则按钮亮着却复制不了）
  const validTarget = copyTargets.some((item) => item.id === copyTarget) ? copyTarget : '';
  const enabledCount = models.filter((model) => model.enabled !== false).length;

  return (
    <div className="model-table-block" data-block="models">
      <div className="model-table-head">
        <h4>
          已选模型
          {models.length > 0 ? (
            <span className="muted small" data-testid="model-count">
              {' '}
              （{models.length} 行，{enabledCount} 行启用）
            </span>
          ) : null}
        </h4>
        <div className="model-table-tools">
          {copyTargets.length > 0 && onCopy ? (
            <>
              <select
                aria-label="复制模型表到"
                value={validTarget}
                onChange={(event) => setCopyTarget(event.target.value)}
              >
                <option value="">复制模型表到…</option>
                {copyTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button ghost"
                aria-label="复制模型表"
                disabled={validTarget === ''}
                title="把当前连接的模型表（含启用状态）复制到同厂商的另一条连接；目标连接原来的模型表会被覆盖"
                onClick={() => onCopy(validTarget)}
              >
                复制模型表
              </button>
            </>
          ) : null}
          <button type="button" className="button ghost" onClick={onAdd}>
            ＋ 手动添加
          </button>
        </div>
      </div>

      {models.length === 0 ? (
        <p className="muted small" role="status">
          填完上面的服务地址与 Key 后会自动带出默认模型；也可以点预设标签自己选。
        </p>
      ) : (
        <table className="model-table">
          <thead>
            <tr>
              <th data-col="enabled">启用</th>
              <th data-col="display">菜单显示名</th>
              <th data-col="model">实际请求模型</th>
              <th data-col="context">上下文窗口</th>
              <th data-col="caps">能力标签</th>
              <th data-col="remove">删除</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model, index) => (
              <tr
                key={model.id}
                data-model-row={model.id}
                data-enabled={model.enabled === false ? 'no' : 'yes'}
              >
                <td data-col="enabled">
                  <input
                    type="checkbox"
                    aria-label={`启用 ${index + 1}`}
                    title="取消勾选 = 临时停用（这条不再出现在可选列表里），不必删行"
                    checked={model.enabled !== false}
                    onChange={(event) => onUpdate(model.id, { enabled: event.target.checked })}
                  />
                </td>
                <td data-col="display">
                  <input
                    type="text"
                    aria-label={`显示名 ${index + 1}`}
                    value={model.displayName}
                    placeholder="菜单里显示的名字"
                    onChange={(event) => onUpdate(model.id, { displayName: event.target.value })}
                  />
                </td>
                <td data-col="model">
                  <input
                    type="text"
                    aria-label={`请求模型 ${index + 1}`}
                    value={model.modelId}
                    placeholder="实际请求的 model"
                    onChange={(event) => onUpdate(model.id, { modelId: event.target.value })}
                  />
                </td>
                <td data-col="context">
                  <input
                    type="number"
                    aria-label={`上下文窗口 ${index + 1}`}
                    value={model.contextLength ?? ''}
                    placeholder="如 128000"
                    min={0}
                    onChange={(event) => {
                      const raw = event.target.value.trim();
                      onUpdate(model.id, {
                        contextLength: raw === '' ? undefined : Number(raw),
                      });
                    }}
                  />
                </td>
                <td data-col="caps">
                  <div className="cap-row">
                    {MODEL_CAPS.map((cap: ModelCap) => (
                      <label key={cap} className="cap-chip">
                        <input
                          type="checkbox"
                          aria-label={`能力 ${CAP_LABELS[cap]} ${index + 1}`}
                          checked={model.caps.includes(cap)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...model.caps, cap]
                              : model.caps.filter((item) => item !== cap);
                            onUpdate(model.id, { caps: MODEL_CAPS.filter((item) => next.includes(item)) });
                          }}
                        />
                        {CAP_LABELS[cap]}
                      </label>
                    ))}
                  </div>
                  {model.note ? <span className="muted small">备注：{model.note}</span> : null}
                </td>
                <td data-col="remove">
                  <button
                    type="button"
                    className="button danger"
                    aria-label={`删除模型 ${index + 1}`}
                    onClick={() => onRemove(model.id)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
