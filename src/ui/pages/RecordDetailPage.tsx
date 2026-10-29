import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getRecordEntity, listRecordsByIds, removeRecord } from '../../core/records';
import { isCopyLike, normalizeRole } from '../../core/records/meta';
import type { RecordEntity, RecordSummary } from '../../core/records/types';
import { removeArtifactsForRecord } from '../../core/artifacts';
import { removeThreadsForRecord } from '../../core/threads';
import { AudioPlayer } from '../components/AudioPlayer';
import { RecordEditor } from '../components/RecordEditor';
import { ArtifactCard } from '../create/ArtifactCards';
import { useRecordArtifacts } from '../create/useRecordArtifacts';
import { describeError, formatDateTime } from '../format';
import '../create/create.css';

/**
 * 记录详情：查看 / 编辑 / 删除 / 回放录音 / 进入创作 + 已生成的产物（M5a2）。
 * 注意：标题与 id 是同步渲染的，异步读库只影响正文区域（断网/首次加载都不白屏）。
 */
export function RecordDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  /** undefined = 加载中，null = 不存在 */
  const [entity, setEntity] = useState<RecordEntity | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * P5：来源素材。
   * - `null` = 还没读（或这条记录本来就没有来源）→ 不渲染区块
   * - `[]` = 读过但一条都找不到（来源全被删了）→ 逐条显示「素材已删除」
   */
  const [sources, setSources] = useState<RecordSummary[] | null>(null);
  const artifacts = useRecordArtifacts(id);

  const sourceIds = entity?.sourceIds ?? [];
  /** 依赖用的稳定串（`sourceIds` 每次渲染都是新数组，不能直接当依赖） */
  const sourceKey = sourceIds.join('|');

  // 读来源素材：`listRecordsByIds` 会跳过已被删的 id（删掉的在渲染时标「素材已删除」），
  // 所以这里永远不会因为「来源没了」而报错或白屏。
  useEffect(() => {
    if (sourceIds.length === 0) {
      setSources(null);
      return;
    }
    let cancelled = false;
    listRecordsByIds(sourceIds)
      .then((rows) => {
        if (!cancelled) setSources(rows);
      })
      .catch(() => {
        // 读不到就当作「都找不到」：显示「素材已删除」比整页报错有用
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceKey]);

  const load = useCallback(async () => {
    if (!id) {
      setEntity(null);
      return;
    }
    setError(null);
    try {
      const found = await getRecordEntity(id);
      setEntity(found ?? null);
    } catch (caught) {
      setError(describeError(caught));
      setEntity(null);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    setError(null);
    try {
      // 产物随记录一起删（本地副本也删，避免留下看不见的孤儿图片）
      await removeArtifactsForRecord(id).catch(() => 0);
      // 会话线程同理：记录没了，线程留着就是不可见的数据垃圾（M5a3）
      await removeThreadsForRecord(id).catch(() => 0);
      await removeRecord(id);
      navigate('/');
    } catch (caught) {
      setError(describeError(caught));
      setDeleting(false);
    }
  }

  return (
    <section className="page">
      <div className="page-header">
        <h2>记录详情</h2>
        <Link to="/" className="button ghost">
          ← 返回列表
        </Link>
      </div>
      <p className="muted small">ID：{id ?? '（未提供）'}</p>

      {error && <p className="error">{error}</p>}

      {entity === undefined && !error && <p className="muted">正在读取…</p>}

      {entity === null && !error && (
        <p className="placeholder">记录 {id ?? ''} 不存在或已被删除。</p>
      )}

      {entity && !editing && (
        <article className="card">
          {/* P5：成品 / 副本在详情页也给一个身份标记（正文是主体，角标只是标签） */}
          {normalizeRole(entity.role) === 'draft' && (
            <span className="record-role-badge" data-record-role-badge="draft">
              成品
            </span>
          )}
          {isCopyLike(entity.role, entity.sourceIds) && (
            <span className="record-badge record-badge-copy" data-record-role-badge="copy">
              副本
            </span>
          )}
          <p className="record-body">{entity.text || '（无文字，仅录音）'}</p>

          {entity.tags.length > 0 && (
            <div className="tag-filter">
              {entity.tags.map((tag) => (
                <span key={tag} className="tag static">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {entity.audio && <AudioPlayer audio={entity.audio} />}

          <p className="muted small">
            创建 {formatDateTime(entity.createdAt)} · 最后修改 {formatDateTime(entity.updatedAt)}
          </p>

          <div className="button-row">
            <Link to={`/create?recordId=${encodeURIComponent(entity.id)}`} className="button">
              进入创作
            </Link>
            <button type="button" className="button primary" onClick={() => setEditing(true)}>
              编辑
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '删除记录'}
            </button>
          </div>
        </article>
      )}

      {/*
        P5 §4.2：「来源素材」区块 —— 成品在下面列出它的来源。
        - 每条一两行摘要，可点开跳转（`/records/<来源 id>`）；
        - **来源被删了显示「素材已删除」**，不报错、不静默少一行
          （`listRecordsByIds` 跳过悬空 id，所以缺的那条要按 `sourceIds` 顺序补位）。
      */}
      {entity && sourceIds.length > 0 && (
        <section className="card record-sources" data-record-sources>
          <h3>来源素材</h3>
          <p className="muted small">
            这条成品是从下面 {sourceIds.length} 条记录来的。
          </p>
          {sources === null ? (
            <p className="muted small">正在读取来源…</p>
          ) : (
            <ul className="record-source-list">
              {sourceIds.map((sourceId, index) => {
                const found = sources.find((item) => item.id === sourceId);
                return (
                  <li
                    key={`${sourceId}-${index}`}
                    className="record-source-item"
                    data-record-source={sourceId}
                  >
                    {found ? (
                      <Link to={`/records/${found.id}`} className="record-source-link">
                        <span className="record-source-no">素材 {index + 1}</span>
                        <span className="record-source-text">
                          {found.text || '（无文字，仅录音）'}
                        </span>
                        {found.tags.length > 0 && (
                          <span className="record-source-tags">
                            {found.tags.slice(0, 2).map((tag) => (
                              <span key={tag} className="record-source-tag">
                                #{tag}
                              </span>
                            ))}
                          </span>
                        )}
                      </Link>
                    ) : (
                      <span className="record-source-missing" data-record-source-missing>
                        <span className="record-source-no">素材 {index + 1}</span>
                        <span>素材已删除</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {entity && (
        <section className="card create-artifacts" data-testid="detail-artifacts">
          <h3>已生成的产物</h3>
          {artifacts.loading && <p className="muted small">正在读取…</p>}
          {!artifacts.loading && artifacts.items.length === 0 && (
            <p className="muted small">还没有产物：点上面的「进入创作」生成解梦、文案或图片。</p>
          )}
          <div className="artifact-list">
            {artifacts.items.map((item) => (
              <ArtifactCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {entity && editing && (
        <RecordEditor
          initial={entity}
          onSaved={(saved) => {
            setEntity(saved);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </section>
  );
}
