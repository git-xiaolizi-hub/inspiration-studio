/**
 * 视频结果落盘（判据 3 / 4.2 第 4 条）。
 *
 * 为什么要立刻下载：官方视频 URL **24 小时后失效，且下载上限 100 次**。
 * 拿到 URL 就当"已经安全"是错的 —— 用户第二天打开就没了。
 *
 * 存放位置用 `core/storage` 的 `media` 仓库（它本来就是"二进制本体"的仓库），
 * `recordId` 用 `video-task:<taskId>` 前缀，**故意不与任何记录 id 冲突**，
 * 以免被"删记录级联删音频"顺手删掉。
 * ⚠️ 已知限制：备份导入的 replace 模式会清空 media 仓库 → 视频会被一起清掉（见 M4b-REPORT §4）。
 */
import { getRecord, putRecord } from '../../core/storage';
import { VIDEO_DOWNLOAD_LIMIT, VIDEO_URL_TTL_MS } from './types';
import type { VideoArtifact } from './types';

export function videoArtifactId(taskId: string): string {
  return `video:${taskId}`;
}

export interface SaveArtifactInput {
  taskId: string;
  blob: Blob;
  remoteUrl: string;
  mimeType?: string;
  /** 可注入时钟（判据 10：24 小时到期不真等） */
  now?: () => number;
}

export async function saveVideoArtifact(input: SaveArtifactInput): Promise<VideoArtifact> {
  const now = (input.now ?? Date.now)();
  const artifact: VideoArtifact = {
    id: videoArtifactId(input.taskId),
    taskId: input.taskId,
    blob: input.blob,
    mimeType: input.mimeType || input.blob.type || 'video/mp4',
    size: input.blob.size,
    createdAt: now,
    expiresAt: now + VIDEO_URL_TTL_MS,
    downloadLimit: VIDEO_DOWNLOAD_LIMIT,
    downloadCount: 1,
    remoteUrl: input.remoteUrl,
  };
  // 复用存储层的配额预检与错误翻译（Don't 绕过 core/storage）
  await putRecord('media', {
    ...artifact,
    recordId: `video-task:${input.taskId}`,
    durationMs: 0,
  });
  return artifact;
}

export async function getVideoArtifact(taskId: string): Promise<VideoArtifact | undefined> {
  const row = await getRecord<VideoArtifact & { id: string }>('media', videoArtifactId(taskId));
  return row;
}

/** 远端 URL 是否已过 24 小时（本地副本仍可用，但不能再重下/重分享） */
export function isArtifactExpired(artifact: Pick<VideoArtifact, 'expiresAt'>, now: number = Date.now()): boolean {
  return now >= artifact.expiresAt;
}

export function remainingHours(artifact: Pick<VideoArtifact, 'expiresAt'>, now: number = Date.now()): number {
  return Math.max(0, Math.round(((artifact.expiresAt - now) / 3_600_000) * 10) / 10);
}

/**
 * UI 提示文案（判据 10）。到期后不能只说"过期了"，要说清楚：
 * 本地副本还在、远端链接不能再下载。
 */
export function artifactNotice(
  artifact: Pick<VideoArtifact, 'expiresAt' | 'downloadLimit' | 'remoteUrl'>,
  now: number = Date.now(),
): string {
  if (isArtifactExpired(artifact, now)) {
    return `官方视频地址已在 24 小时后失效（本地副本仍可播放）；远端链接下载上限 ${artifact.downloadLimit} 次，失效后需重新生成`;
  }
  return `官方视频地址将在约 ${remainingHours(artifact, now)} 小时后失效（下载上限 ${
    artifact.downloadLimit
  } 次）；本地副本已保存，不受影响`;
}

/** blob URL：环境不支持时给出可读错误，而不是返回一个假的地址 */
export function makeBlobUrl(blob: Blob): string {
  const factory = typeof URL !== 'undefined' ? URL.createObjectURL : undefined;
  if (typeof factory !== 'function') {
    throw new Error('当前环境不支持 URL.createObjectURL，无法生成本地播放地址');
  }
  return factory.call(URL, blob);
}

export function revokeBlobUrl(url: string): void {
  if (!url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // 已释放或环境不支持：忽略
  }
}

/* ------------------------------------------------------------------ */
/* M4c：给第二家适配器复用的"下载字节 → 落盘 → 给播放地址"一段          */
/* ------------------------------------------------------------------ */

export interface StoreFetchedVideoInput {
  taskId: string;
  bytes: ArrayBuffer;
  /** 响应头里的 content-type；拿不到就按 video/mp4 */
  mimeType?: string;
  remoteUrl: string;
  now?: () => number;
}

export interface StoredFetchedVideo {
  artifact: VideoArtifact;
  /** 本地播放地址（blob:） */
  blobUrl: string;
}

/**
 * 把已经拿到手的字节存进本地库并返回播放地址。
 *
 * 为什么放在 storage 而不是各适配器里：下载 → 落盘 → 24 小时有效期 → blob URL
 * 这一整段与"哪家模型"无关，是**真正能共用的一层**。
 * （Ark 的 `downloadAndStore` 里还有一份同样的逻辑，本轮**不改它**以免动到 M4b 的对外行为；
 * 以后要合并时把 Ark 也换成这个函数即可，签名完全兼容。）
 */
export async function storeFetchedVideo(input: StoreFetchedVideoInput): Promise<StoredFetchedVideo> {
  const mimeType = input.mimeType || 'video/mp4';
  const blob = new Blob([input.bytes], { type: mimeType });
  const artifact = await saveVideoArtifact({
    taskId: input.taskId,
    blob,
    remoteUrl: input.remoteUrl,
    mimeType,
    now: input.now,
  });
  return { artifact, blobUrl: makeBlobUrl(artifact.blob) };
}
