/**
 * 「本地模型」管理弹窗（R7m）。
 *
 * 委托人原话：「云端模型旁有个配置按钮，可以给本地模型也安排一个配置按钮，
 * 效果是一个弹窗，能显示选项（几个能下载的模型），可以点击下载也可以切换已下载的模型，还可以删除。」
 *
 * 所以这里只做三件事：列出可下载的模型、下载/删除、选一个当当前模型。
 * 模型文件本身在 Cache Storage 里（见 adapters/asr/model-store.ts），删掉即卸载。
 */
import { useCallback, useEffect, useState } from 'react';
import { MODEL_PACKS, type ModelPack } from '../../adapters/asr/model-spec';
import { downloadPack, isPackCached, removePack, type PackProgress } from '../../adapters/asr/model-store';
import { describeError } from '../format';
import { Dialog } from './Dialog';

export interface LocalModelDialogProps {
  open: boolean;
  onDismiss: () => void;
  /** 当前在用的模型 id（settings.localModelId 或探测结果） */
  activeId: string | null;
  /** 选一个模型当当前模型 */
  onUse: (pack: ModelPack) => void;
  /** 测试注入 */
  cacheState?: (id: ModelPack['id']) => Promise<boolean>;
  download?: (id: ModelPack['id'], onProgress: (p: PackProgress) => void) => Promise<void>;
  remove?: (id: ModelPack['id']) => Promise<void>;
}

type RowState = 'checking' | 'absent' | 'present';

export function LocalModelDialog({
  open,
  onDismiss,
  activeId,
  onUse,
  cacheState,
  download,
  remove,
}: LocalModelDialogProps) {
  // ⚠️ 必须是稳定引用：下面的 useEffect 依赖 check，
  // 每次渲染新建一个函数会导致 effect 反复触发 → setState → 死循环（真踩过）。
  const check = useCallback(
    (id: ModelPack['id']) => (cacheState ? cacheState(id) : isPackCached(id)),
    [cacheState],
  );
  const doDownload = useCallback(
    (id: ModelPack['id'], onProgress: (p: PackProgress) => void) =>
      download ? download(id, onProgress) : downloadPack(id, onProgress),
    [download],
  );
  const doRemove = useCallback(
    (id: ModelPack['id']) => (remove ? remove(id) : removePack(id)),
    [remove],
  );

  const [states, setStates] = useState<Record<string, RowState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<PackProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都重新查一遍（用户可能在别的标签页删过缓存）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setProgress(null);
    setStates(Object.fromEntries(MODEL_PACKS.map((pack) => [pack.id, 'checking'])) as Record<string, RowState>);
    void Promise.all(
      MODEL_PACKS.map(async (pack) => {
        const present = await check(pack.id).catch(() => false);
        if (!cancelled) {
          setStates((prev) => ({ ...prev, [pack.id]: present ? 'present' : 'absent' }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [open, check]);

  async function handleDownload(pack: ModelPack) {
    setError(null);
    setBusyId(pack.id);
    setProgress({ stage: 'downloading', pct: 0 });
    try {
      await doDownload(pack.id, (p) => setProgress(p));
      setStates((prev) => ({ ...prev, [pack.id]: 'present' }));
      setProgress({ stage: 'done' });
      onUse(pack);
    } catch (caught) {
      setError(describeError(caught));
      setProgress(null);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(pack: ModelPack) {
    setError(null);
    setBusyId(pack.id);
    try {
      await doRemove(pack.id);
      setStates((prev) => ({ ...prev, [pack.id]: 'absent' }));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusyId(null);
    }
  }

  const pct =
    progress?.stage === 'downloading' || progress?.stage === 'saving'
      ? progress.pct
      : progress?.stage === 'done'
        ? 100
        : 0;

  return (
    <Dialog
      open={open}
      title="本地模型"
      label="本地模型管理"
      onDismiss={onDismiss}
      actions={[{ label: '关闭', onClick: onDismiss, testId: 'local-model-close' }]}
    >
      <p className="modal-sub">
        模型下载后存在这台设备的浏览器里，断网也能转写；删掉就是卸载。
      </p>

      <div className="local-model-list">
        {MODEL_PACKS.map((pack) => {
          const state = states[pack.id] ?? 'checking';
          const isActive = activeId === pack.id && state === 'present';
          const busy = busyId === pack.id;
          return (
            <div className="local-model-row" key={pack.id} data-testid={`local-model-${pack.id}`}>
              <div className="local-model-main">
                <span className="local-model-name">
                  {pack.label}
                  {isActive && <span className="voice-opt-tag">使用中</span>}
                </span>
                <span className="local-model-meta">
                  {pack.sizeMB}MB（下载 {pack.downloadMB}MB）·{' '}
                  {state === 'checking'
                    ? '检查中…'
                    : state === 'present'
                      ? '已下载'
                      : '未下载'}
                </span>
              </div>
              <div className="local-model-actions">
                {state === 'present' ? (
                  <>
                    {!isActive && (
                      <button
                        type="button"
                        className="button small"
                        data-testid={`local-model-use-${pack.id}`}
                        onClick={() => onUse(pack)}
                        disabled={busy}
                      >
                        使用
                      </button>
                    )}
                    <button
                      type="button"
                      className="voice-opt-link is-danger"
                      data-testid={`local-model-remove-${pack.id}`}
                      onClick={() => void handleRemove(pack)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button small primary"
                    data-testid={`local-model-download-${pack.id}`}
                    onClick={() => void handleDownload(pack)}
                    disabled={busy || state === 'checking'}
                  >
                    {busy ? '下载中…' : '下载'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {progress && busyId && (
        <div className="voice-progress">
          <div className="voice-progress-bar">
            <span className="voice-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="voice-progress-text">
            {progress.stage === 'downloading' && `正在下载 ${progress.pct}%`}
            {progress.stage === 'saving' && `正在写入 ${progress.pct}%`}
            {progress.stage === 'done' && '完成'}
          </span>
        </div>
      )}

      {error && <p className="error small">{error}</p>}
    </Dialog>
  );
}
