/**
 * 产物的卡片渲染（创作页的新结果 + 记录详情页的历史，共用同一套）。
 *
 * 三类形状分别来自：
 * - `dream`  → packs/dream-interpretation 的 output（interpretation / symbols / disclaimer）
 * - `copy`   → packs/story-expansion 的 output（directions[] / disclaimer）
 * - `image`  → `ImageArtifactPayload`（提示词 / 远端地址 / media 主键 / 时效）
 *
 * 纪律：**不写 markdown**（项目里已经犯过三次 `**` 直接显示成星号）。
 */
import type { ArtifactRow } from '../../core/storage/db';

export interface ArtifactItem {
  id: string;
  kind: string;
  payload: unknown;
  modelId: string;
  cost: number;
  createdAt: number;
  /** 图片的本地 blob URL（其它类型没有） */
  blobUrl?: string;
  /** 图片的时效提示（已按 verified 标好"未核实"） */
  ttlNotice?: string;
  /**
   * 会话里内联渲染时用：卡片底部的「时间 · 模型 · 花费」由对话本身提供，
   * 再画一遍就成了两行互相打架的元信息（M5a3 加的字段，默认 false = 老行为不变）。
   */
  hideMeta?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function DreamCard({ item }: { item: ArtifactItem }) {
  const payload = asRecord(item.payload);
  const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];

  return (
    <article className="artifact-card" data-kind="dream" data-testid={`artifact-${item.id}`}>
      <h4>解梦</h4>
      <p className="artifact-body">{asString(payload.interpretation) || '（模型没有给出解读正文）'}</p>
      {symbols.length > 0 && (
        <ul className="artifact-symbols">
          {symbols.map((raw, index) => {
            const symbol = asRecord(raw);
            return (
              <li key={`${asString(symbol.symbol)}-${index}`}>
                <strong>{asString(symbol.symbol)}</strong>
                {'：'}
                {asString(symbol.meaning)}
              </li>
            );
          })}
        </ul>
      )}
      {asString(payload.disclaimer) && (
        <p className="muted small">{asString(payload.disclaimer)}</p>
      )}
      {!item.hideMeta && (
        <p className="muted small">
          {formatTime(item.createdAt)} · {item.modelId} ·{' '}
          {item.cost > 0 ? `¥${item.cost.toFixed(2)}` : '免费'}
        </p>
      )}
    </article>
  );
}

export function CopyCard({ item }: { item: ArtifactItem }) {
  const payload = asRecord(item.payload);
  const directions = Array.isArray(payload.directions) ? payload.directions : [];

  return (
    <article className="artifact-card" data-kind="copy" data-testid={`artifact-${item.id}`}>
      <h4>三个方向</h4>
      <div className="direction-grid">
        {directions.map((raw, index) => {
          const direction = asRecord(raw);
          const beats = Array.isArray(direction.beats) ? direction.beats : [];
          const borrowed = Array.isArray(direction.borrowed) ? direction.borrowed : [];
          return (
            <section className="direction" key={`${asString(direction.title)}-${index}`}>
              <h5>{asString(direction.title)}</h5>
              <p>
                <span className="muted small">一句话：</span>
                {asString(direction.logline)}
              </p>
              <p>
                <span className="muted small">冲突：</span>
                {asString(direction.conflict)}
              </p>
              <p>
                <span className="muted small">为什么成立：</span>
                {asString(direction.why_it_holds)}
              </p>
              {beats.length > 0 && (
                <ol>
                  {beats.map((beat, beatIndex) => (
                    <li key={beatIndex}>{String(beat)}</li>
                  ))}
                </ol>
              )}
              {borrowed.length > 0 && (
                <p className="muted small">借自记录：{borrowed.map((item) => String(item)).join(' / ')}</p>
              )}
            </section>
          );
        })}
      </div>
      {!item.hideMeta && (
        <p className="muted small">
          {formatTime(item.createdAt)} · {item.modelId} ·{' '}
          {item.cost > 0 ? `¥${item.cost.toFixed(2)}` : '免费'}
        </p>
      )}
    </article>
  );
}

export function ImageCard({ item }: { item: ArtifactItem }) {
  const payload = asRecord(item.payload);
  return (
    <article className="artifact-card" data-kind="image" data-testid={`artifact-${item.id}`}>
      {item.blobUrl ? (
        <img className="artifact-thumb" src={item.blobUrl} alt={asString(payload.prompt) || '生成的图片'} />
      ) : (
        <p className="warn-inline">本地副本读不出来（可能被清理了）</p>
      )}
      <p className="artifact-prompt">{asString(payload.prompt)}</p>
      <p className="muted small">
        模型 {item.modelId}
        {' · '}
        {item.cost > 0 ? `花费 ¥${item.cost.toFixed(2)}` : '免费'}
        {asString(payload.imageSize) ? ` · ${asString(payload.imageSize)}` : ''}
      </p>
      {item.ttlNotice && <p className="muted small">{item.ttlNotice}</p>}
    </article>
  );
}

/** 追问里存下来的自由文本（M5a3）：「存为产物」不能把一段对话伪装成解梦卡片 */
export function NoteCard({ item }: { item: ArtifactItem }) {
  const payload = asRecord(item.payload);
  return (
    <article className="artifact-card" data-kind="note" data-testid={`artifact-${item.id}`}>
      <h4>对话回答</h4>
      <p className="artifact-body">{asString(payload.text) || '（这条回答是空的）'}</p>
      <p className="muted small">
        {formatTime(item.createdAt)} · 追问存下来的文本（不是 pack 的结构化输出）
      </p>
    </article>
  );
}

/** 按 kind 分派；未知 kind 不渲染（不要为了"有东西显示"编一张卡片） */
export function ArtifactCard({ item }: { item: ArtifactItem }) {
  if (item.kind === 'dream') return <DreamCard item={item} />;
  if (item.kind === 'copy') return <CopyCard item={item} />;
  if (item.kind === 'image') return <ImageCard item={item} />;
  if (item.kind === 'note') return <NoteCard item={item} />;
  return null;
}

/** 数据库行 → 卡片数据（图片的 blobUrl / 时效由调用方补齐） */
export function toArtifactItem(row: ArtifactRow): ArtifactItem {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    modelId: row.modelId,
    cost: row.cost,
    createdAt: row.createdAt,
  };
}

export { formatTime as formatArtifactTime };
