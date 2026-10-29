/**
 * AI 产物（artifacts）的数据层（M5a2）。
 *
 * 为什么单开一层而不是塞进 `core/records`：产物属于"某条记录生成了什么"，
 * 它的生命周期、读取方式和记录本身不同（记录是文本 + 标签，产物是结构化 JSON + 二进制引用）。
 * 记录模块的对外签名（`createRecord` / `listRecords` / `removeRecord`）本轮一个字节都没改。
 *
 * 二进制约定：图片字节在 `media` 表，主键 `image-blob:<key>`；这里只存引用。
 * `recordId` 用 `artifact:<id>` 前缀，**故意不等于记录 id** ——
 * 否则会被 `removeRecord()` 的"删记录级联删音频"顺手删掉，而删除应该由本模块显式做。
 */
import { getDatabase } from '../storage/db';
import type { ArtifactRow } from '../storage/db';
import { deleteRecord } from '../storage';

export type ArtifactKind = 'dream' | 'copy' | 'image' | 'note';

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  dream: '解梦',
  copy: '灵感与文案',
  image: '生图',
  /** M5a3：追问里「存为产物」留下的自由文本 */
  note: '对话回答',
};

export interface SaveArtifactInput {
  recordId: string;
  kind: ArtifactKind;
  /** 结构化结果本体（dream/copy 是 pack 输出 JSON；image 是图片元信息） */
  payload: unknown;
  modelId: string;
  /** 本次实际花费（元）；免费或价格未核实时传 0 并在 payload 里注明 */
  cost: number;
  /** 可注入时钟（测试断言排序用） */
  now?: () => number;
  /** 显式 id（图片落盘时 media 主键与 artifact id 同源，需要外部给） */
  id?: string;
}

function createArtifactId(kind: ArtifactKind): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  const suffix =
    globalCrypto && typeof globalCrypto.randomUUID === 'function'
      ? globalCrypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `${kind}:${suffix}`;
}

export async function saveArtifact(input: SaveArtifactInput): Promise<ArtifactRow> {
  const row: ArtifactRow = {
    id: input.id ?? createArtifactId(input.kind),
    recordId: input.recordId,
    kind: input.kind,
    payload: input.payload,
    modelId: input.modelId,
    cost: Number.isFinite(input.cost) ? input.cost : 0,
    createdAt: (input.now ?? Date.now)(),
  };
  await getDatabase().artifacts.put(row);
  return row;
}

export async function getArtifact(id: string): Promise<ArtifactRow | undefined> {
  return getDatabase().artifacts.get(id);
}

/** 一条记录的全部产物（按生成时间正序：先看到的先发生，符合阅读顺序） */
export async function listArtifacts(recordId: string): Promise<ArtifactRow[]> {
  const rows = await getDatabase().artifacts.where('recordId').equals(recordId).toArray();
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/** 删一条产物（图片还要删 media 里那一行；blob 引用从 payload 里取） */
export async function removeArtifact(id: string): Promise<void> {
  const artifact = await getArtifact(id);
  await getDatabase().artifacts.delete(id);
  const blobId = readBlobId(artifact?.payload);
  if (blobId) await deleteRecord('media', blobId);
}

/** 删一条记录的全部产物（记录被删时由 UI 显式调用，见报告 §3.3 的取舍） */
export async function removeArtifactsForRecord(recordId: string): Promise<number> {
  const rows = await listArtifacts(recordId);
  for (const row of rows) {
    await removeArtifact(row.id);
  }
  return rows.length;
}

/** 从 image payload 里取 media 主键（形状不对就返回 undefined，不抛） */
export function readBlobId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>).blobId;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** UI 用：一行摘要（不把整段 JSON 铺在列表里） */
export function artifactSummary(row: ArtifactRow): string {
  const payload = row.payload;
  if (row.kind === 'dream' && payload !== null && typeof payload === 'object') {
    const text = (payload as Record<string, unknown>).interpretation;
    if (typeof text === 'string') return text.slice(0, 60);
  }
  if (row.kind === 'copy' && payload !== null && typeof payload === 'object') {
    const directions = (payload as Record<string, unknown>).directions;
    if (Array.isArray(directions)) {
      const titles = directions
        .map((item) =>
          item !== null && typeof item === 'object'
            ? String((item as Record<string, unknown>).title ?? '')
            : '',
        )
        .filter((title) => title !== '');
      if (titles.length > 0) return titles.join(' · ');
    }
  }
  if (row.kind === 'image' && payload !== null && typeof payload === 'object') {
    const prompt = (payload as Record<string, unknown>).prompt;
    if (typeof prompt === 'string') return prompt.slice(0, 60);
  }
  return '';
}
