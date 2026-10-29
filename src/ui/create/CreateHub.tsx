/**
 * 创作入口页（P2 §1）：`/#/create` 不带 `recordId` 时落在这里。
 *
 * 三块磁贴，位置由委托人定：
 *   ┌ 工作流画板[主推] ┬ 写作工作台 ┐   两卡等高、标题同一水平线
 *   ├ 单卡创作（跨两列，吃满剩余高度）─┤
 * 单卡创作里是「最近 7 条记录 + 查看全部 N 条」。
 *
 * 三条硬约束：
 * 1. **有 recordId 就直达单卡创作**——分流在 `CreateRoute` 里做，这个文件不碰深链；
 * 2. 卡片里的节点图 / 三栏图是**静态示意**，不挂真实画板组件（P3 才动画布）；
 * 3. 一条记录都没有时不留空白格，给一句可执行提示（去首页写第一条）。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listRecords } from '../../core/records';
import type { RecordSummary } from '../../core/records/types';
import { describeError, startOfToday } from '../format';
import './create.css';

/** 单卡创作卡里最多列几条：4 列 × 2 行，最后一格留给「查看全部」 */
export const HUB_RECORD_LIMIT = 7;

/**
 * 工作流示意节点（纯静态）。
 *
 * 位置用百分比而不是 px：预览区高度随窗口变，px 会让节点在矮屏上叠在一起。
 * 数值照样张的相对位置取整（第一排 4 个、第二排 3 个，生图 / 生视频高亮）。
 */
const HUB_FLOW_NODES: ReadonlyArray<{ label: string; left: string; top: string; hot?: boolean }> = [
  { label: '文本源', left: '3%', top: '22%' },
  { label: '解梦', left: '15%', top: '22%' },
  { label: '剧本', left: '27%', top: '22%' },
  { label: '分镜', left: '39%', top: '22%' },
  { label: '生图', left: '15%', top: '56%', hot: true },
  { label: '生视频', left: '28%', top: '56%', hot: true },
  { label: '输出', left: '43%', top: '56%' },
];

/** 写作工作台示意里的素材条（静态占位，不读真实记录） */
const HUB_WRITING_CHIPS = ['素材', '正文', 'AI'] as const;

/** 「今天 12:03 / 昨天 23:41 / 10-19 18:02」——列表页用的是完整日期，这里空间窄，用相对说法 */
export function hubStamp(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = startOfToday(now);
  if (timestamp >= today) return `今天 ${clock}`;
  if (timestamp >= startOfToday(today - 1)) return `昨天 ${clock}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

interface HubState {
  items: RecordSummary[];
  total: number;
}

export function CreateHub() {
  const [state, setState] = useState<HubState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await listRecords({ page: 1, pageSize: HUB_RECORD_LIMIT });
        if (cancelled) return;
        setState({ items: result.items, total: result.total });
      } catch (caught) {
        if (!cancelled) setError(describeError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const items = state?.items ?? [];
  const total = state?.total ?? 0;
  /** 「查看全部」只在真的还有没显示出来的记录时出现（否则点了也只是回同一个列表） */
  const hidden = Math.max(0, total - items.length);

  return (
    <section className="page page-create-hub">
      <header className="hub-head">
        <h2>创作</h2>
        <p className="muted small">从一条想法到成片。选一种方式开始。</p>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="hub-grid">
        <Link className="hub-tile" to="/workflow" data-testid="hub-tile-workflow">
          <h3 className="hub-tile-title">
            工作流画板
            <span className="hub-kicker">主推</span>
          </h3>
          <p className="hub-tile-desc">
            把一条梦拆成可执行步骤，每一步单独看结果、单独重跑，花钱的会先问你。
          </p>
          <div className="hub-flow" aria-hidden="true">
            {HUB_FLOW_NODES.map((node) => (
              <span
                key={node.label}
                className={node.hot ? 'hub-node hub-node-hot' : 'hub-node'}
                style={{ left: node.left, top: node.top }}
              >
                {node.label}
              </span>
            ))}
          </div>
          <span className="hub-go">打开画板 →</span>
        </Link>

        <Link className="hub-tile" to="/studio" data-testid="hub-tile-writing">
          <h3 className="hub-tile-title">写作工作台</h3>
          <p className="hub-tile-desc">
            左边挑素材，中间展开写，右边让 AI 接着写。几条梦可以拧成同一个故事。
          </p>
          <div className="hub-ide" aria-hidden="true">
            {HUB_WRITING_CHIPS.map((chip, index) => (
              <div className="hub-pane" key={chip}>
                <span className="hub-pane-title">{chip}</span>
                {index === 0 ? (
                  <>
                    <span className="hub-pane-chip" />
                    <span className="hub-pane-chip" />
                    <span className="hub-pane-chip" />
                    <span className="hub-pane-chip" />
                  </>
                ) : (
                  <>
                    <span className="hub-pane-line" />
                    <span className="hub-pane-line" />
                    <span className="hub-pane-line hub-pane-line-short" />
                  </>
                )}
              </div>
            ))}
          </div>
          <span className="hub-go">打开工作台 →</span>
        </Link>

        <section className="hub-tile hub-tile-wide" data-testid="hub-tile-card">
          <h3 className="hub-tile-title">单卡创作</h3>
          <p className="hub-tile-desc">选一条记录，直接对它做一件事：解梦、写文案、生图、生视频。</p>

          {state === null ? (
            <p className="muted small">正在读取记录…</p>
          ) : items.length === 0 ? (
            <p className="muted small">
              还没有记录。
              <Link className="guide-link" to="/">
                去首页写下第一条 →
              </Link>
            </p>
          ) : (
            <div className="hub-recs">
              {items.map((item) => (
                <Link
                  className="hub-rec"
                  key={item.id}
                  to={`/create?recordId=${encodeURIComponent(item.id)}`}
                  data-testid={`hub-record-${item.id}`}
                >
                  <span className="hub-rec-text">{item.text.trim() || '（无文字，仅录音）'}</span>
                  <span className="hub-rec-meta">
                    {item.tags.length > 0 && <span className="hub-rec-tag">#{item.tags[0]}</span>}
                    <span>{hubStamp(item.createdAt)}</span>
                  </span>
                </Link>
              ))}
              {hidden > 0 && (
                <Link className="hub-rec hub-rec-more" to="/" data-testid="hub-more">
                  查看全部 {total} 条 →
                </Link>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="hub-foot">
        也可以从任意一条记录的详情页点「进入创作」，直接带上这条记录。
      </footer>
    </section>
  );
}
