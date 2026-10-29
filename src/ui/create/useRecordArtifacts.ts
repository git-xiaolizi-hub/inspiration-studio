/**
 * 读"这条记录已有的产物"，并把图片的本地副本变成可用地址。
 *
 * 为什么抽成 hook：创作页生成完要刷新列表，记录详情页一进来也要列同一份数据。
 * 两处各写一遍的下场是"详情页少了时效提示、创作页少了空态"这种不对称。
 */
import { useCallback, useEffect, useState } from 'react';
import { listArtifacts } from '../../core/artifacts';
import { getStoredImage, imageTtlNotice, makeBlobUrl } from '../../adapters/image/storage';
import type { ArtifactItem } from './ArtifactCards';
import { toArtifactItem } from './ArtifactCards';

function readImageMeta(payload: unknown): {
  blobId?: string;
  expiresAt?: number;
  ttlVerified?: boolean;
  ttlNote?: string;
} {
  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  return {
    blobId: typeof record.blobId === 'string' ? record.blobId : undefined,
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : undefined,
    ttlVerified: typeof record.ttlVerified === 'boolean' ? record.ttlVerified : undefined,
    ttlNote: typeof record.ttlNote === 'string' ? record.ttlNote : undefined,
  };
}

export interface UseRecordArtifactsResult {
  items: ArtifactItem[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useRecordArtifacts(recordId: string | undefined): UseRecordArtifactsResult {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    if (!recordId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const run = async () => {
      try {
        const rows = await listArtifacts(recordId);
        const resolved: ArtifactItem[] = [];
        for (const row of rows) {
          const item = toArtifactItem(row);
          if (row.kind === 'image') {
            const meta = readImageMeta(row.payload);
            if (meta.blobId) {
              const stored = await getStoredImage(meta.blobId);
              if (stored) {
                try {
                  item.blobUrl = makeBlobUrl(stored.blob);
                } catch {
                  // 环境不支持 blob URL（个别测试环境）：卡片会显示"读不出来"，不猜一个假地址
                }
              }
            }
            if (typeof meta.expiresAt === 'number') {
              item.ttlNotice = imageTtlNotice({
                expiresAt: meta.expiresAt,
                ttlVerified: meta.ttlVerified === true,
                ttlNote: meta.ttlNote ?? '',
              });
            }
          }
          resolved.push(item);
        }
        if (!cancelled) {
          setItems(resolved);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [recordId, reloadKey]);

  return { items, loading, error, reload };
}
