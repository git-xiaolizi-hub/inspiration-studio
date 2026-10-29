/**
 * 会话视图（M5a3）：解梦 / 灵感与文案 的对话区。
 *
 * 纯展示 + 回调，**不发请求、不写库**：调模型的编排都在 `CreatePage` 里，
 * 这样"停止/重试/重新生成"这套状态机只有一处，不会被两个文件各写一遍。
 *
 * 纪律：
 * - 不写 markdown（项目里已经犯过三次 `**` 直接显示成星号）；
 * - 失败轮显示错误 + 「重试」，且**不隐藏**（用户得知道这句没答上来）；
 * - token 一律带「≈」和「估算」，不假装精确。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Thread, Turn } from '../../core/threads';
import { threadLabel } from '../../core/threads';
import { ArtifactCard } from './ArtifactCards';
import type { ArtifactItem } from './ArtifactCards';
import type { ContextBudget } from './context-budget';

export interface ThreadViewProps {
  thread: Thread;
  /** 同一记录 + 同一 kind 的全部会话（按最近更新排序） */
  threads: Thread[];
  busy: boolean;
  budget: ContextBudget;
  /** 生成按钮旁的小字（费用；没有就 null） */
  costLine: string | null;
  /** 不能发送的原因（未接入模型等）；null = 可以发 */
  disabledReason: string | null;
  /** 已存成产物的自由文本轮下标（按钮显示「已存为产物」） */
  savedTurns: ReadonlySet<number>;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: (index: number) => void;
  onRetry: (index: number) => void;
  onSaveArtifact: (index: number) => void;
  onNewThread: () => void;
  onSwitchThread: (threadId: string) => void;
  /** 空会话里的首轮按钮（新会话刚开、还没有第一轮） */
  onStartFirst: () => void;
  firstTurnLabel: string;
  firstTurnCostLine: string | null;
}

function structuredItem(thread: Thread, turn: Turn, index: number): ArtifactItem {
  return {
    id: `${thread.id}#${index}`,
    kind: thread.kind,
    payload: turn.structured,
    modelId: '',
    cost: 0,
    createdAt: turn.at,
    hideMeta: true,
  };
}

export function ThreadView(props: ThreadViewProps) {
  const {
    thread,
    threads,
    busy,
    budget,
    costLine,
    disabledReason,
    savedTurns,
    onSend,
    onStop,
    onRegenerate,
    onRetry,
    onSaveArtifact,
    onNewThread,
    onSwitchThread,
    onStartFirst,
    firstTurnLabel,
    firstTurnCostLine,
  } = props;

  const [draft, setDraft] = useState('');

  const lastAssistantIndex = (() => {
    for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
      if (thread.turns[index].role === 'assistant') return index;
    }
    return -1;
  })();

  const canSend = disabledReason === null && !busy && draft.trim() !== '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    const text = draft.trim();
    if (text === '') return;
    setDraft('');
    onSend(text);
  };

  return (
    <div className="thread" data-testid="thread-panel">
      {threads.length > 1 && (
        <label className="field create-model">
          <span>会话</span>
          <select
            aria-label="切换会话"
            data-testid="thread-switch"
            value={thread.id}
            onChange={(event) => onSwitchThread(event.target.value)}
          >
            {threads.map((item) => (
              <option key={item.id} value={item.id}>
                {threadLabel(item)}
              </option>
            ))}
          </select>
        </label>
      )}

      {budget.warn && (
        <div className="thread-warn" role="status" data-testid="thread-warn">
          <p>这个会话已经很长，继续可能变慢/变贵。建议开新会话（记录里的内容不会丢）。</p>
          <button type="button" className="button ghost" data-testid="thread-new-from-warn" onClick={onNewThread}>
            开新会话
          </button>
        </div>
      )}

      {thread.turns.length === 0 && (
        <div className="create-actions">
          <button
            type="button"
            className="button primary"
            data-testid="thread-start"
            disabled={busy}
            onClick={onStartFirst}
          >
            {firstTurnLabel}
          </button>
          {firstTurnCostLine !== null && (
            <span className="muted small create-cost">{firstTurnCostLine}</span>
          )}
        </div>
      )}

      <ol className="thread-turns" data-testid="thread-turns">
        {thread.turns.map((turn, index) => {
          const isAssistant = turn.role === 'assistant';
          const isLastAssistant = index === lastAssistantIndex;
          return (
            <li
              key={`${turn.at}-${index}`}
              className={`thread-turn ${turn.role}`}
              data-role={turn.role}
              data-testid={`thread-turn-${index}`}
            >
              <span className="thread-role">{isAssistant ? '助手' : '我'}</span>
              <div className="thread-body">
                {turn.error !== undefined ? (
                  <div className="thread-error" data-testid={`thread-turn-error-${index}`}>
                    <p className="warn-inline">这次没答上来：{turn.error}</p>
                    <button
                      type="button"
                      className="button ghost"
                      disabled={busy}
                      onClick={() => onRetry(index)}
                    >
                      重试
                    </button>
                  </div>
                ) : turn.structured !== undefined ? (
                  <ArtifactCard item={structuredItem(thread, turn, index)} />
                ) : (
                  <p className="thread-text">{turn.content}</p>
                )}

                {isAssistant && turn.error === undefined && (
                  <div className="thread-turn-actions">
                    {turn.structured !== undefined ? (
                      <button type="button" className="button ghost" disabled>
                        已存为产物
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button ghost"
                        data-testid={`thread-save-${index}`}
                        disabled={savedTurns.has(index) || busy}
                        onClick={() => onSaveArtifact(index)}
                      >
                        {savedTurns.has(index) ? '已存为产物' : '存为产物'}
                      </button>
                    )}
                    {isLastAssistant && (
                      <button
                        type="button"
                        className="button ghost"
                        data-testid={`thread-regenerate-${index}`}
                        disabled={busy}
                        onClick={() => onRegenerate(index)}
                      >
                        重新生成
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
        {busy && (
          <li className="thread-turn assistant" data-role="assistant" data-testid="thread-pending">
            <span className="thread-role">助手</span>
            <div className="thread-body">
              <p className="muted small">正在生成…</p>
            </div>
          </li>
        )}
      </ol>

      {thread.turns.length > 0 && (
        <form className="thread-composer" onSubmit={submit}>
        <textarea
          aria-label="追问输入"
          data-testid="thread-input"
          rows={2}
          placeholder="接着问，比如：那汤里浮着的钥匙是什么意思？"
          value={draft}
          disabled={disabledReason !== null || busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="thread-composer-actions">
          <button type="submit" className="button primary" data-testid="thread-send" disabled={!canSend}>
            发送
          </button>
          {busy && (
            <button type="button" className="button ghost" data-testid="thread-stop" onClick={onStop}>
              停止
            </button>
          )}
          <button type="button" className="button ghost" data-testid="thread-new" onClick={onNewThread}>
            新会话
          </button>
          <span className="muted small" data-testid="thread-tokens">
            累计 ≈{budget.tokens} token（估算，窗口 ≈{budget.window} 的 {budget.percent}%）
          </span>
          {costLine !== null && <span className="muted small create-cost">{costLine}</span>}
        </div>
        {disabledReason !== null && <p className="warn-inline">{disabledReason}</p>}
        </form>
      )}
    </div>
  );
}
