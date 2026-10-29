/**
 * 响应解析（防御式）。
 *
 * 任务书 §4.2.5 明确要求：**视频 URL 的字段位置未能从文档确证**，所以按三条路径依次尝试，
 * 并记录实际命中的路径（`url_path`），供第一次真跑后校正。
 *
 * 已知的文档线索（`ark-seedance-2.5.txt`「Step1:生成 Draft 视频」）：
 * 「当任务状态变为 succeeded 后，可在 **content.video_url** 字段处下载」→ 第 2 条路径是文档线索，
 * 但该页不是 API 参考页，**仍按未验证处理**（真跑一次才能钉死）。
 *
 * 三条路径（顺序即优先级）：
 *   ① `content[]` 中 `type === 'video_url'` 的条目的 `video_url.url`
 *   ② `content.video_url`（对象取 `.url`，字符串直接用）
 *   ③ 顶层 `video_url`（同上）
 */
import { VideoError } from './errors';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function pickUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  const record = asRecord(value);
  const url = record?.url;
  if (typeof url === 'string' && url.trim() !== '') return url.trim();
  return null;
}

export interface ExtractedVideoResult {
  video_url: string;
  /** 实际命中的响应路径，例如 `content[0].video_url.url` */
  url_path: string;
  last_frame_url?: string;
  usage: { completion_tokens: number };
}

export function extractVideoResult(payload: unknown): ExtractedVideoResult | null {
  const root = asRecord(payload);
  if (!root) return null;

  let videoUrl: string | null = null;
  let urlPath = '';

  const content = root.content;
  if (Array.isArray(content)) {
    for (let index = 0; index < content.length; index += 1) {
      const item = asRecord(content[index]);
      if (!item) continue;
      if (item.type !== 'video_url' && item.type !== 'video') continue;
      const candidate = pickUrl(item.video_url) ?? pickUrl(item);
      if (candidate) {
        videoUrl = candidate;
        urlPath = `content[${index}].video_url.url`;
        break;
      }
    }
  }

  if (!videoUrl) {
    const candidate = pickUrl(root.content && !Array.isArray(root.content) ? asRecord(root.content)?.video_url : undefined);
    if (candidate) {
      videoUrl = candidate;
      urlPath = 'content.video_url';
    }
  }

  if (!videoUrl) {
    const candidate = pickUrl(root.video_url);
    if (candidate) {
      videoUrl = candidate;
      urlPath = 'video_url';
    }
  }

  if (!videoUrl) return null;

  const usageRecord = asRecord(root.usage);
  const completionTokens = Number(usageRecord?.completion_tokens ?? 0);

  return {
    video_url: videoUrl,
    url_path: urlPath,
    last_frame_url: pickUrl(root.last_frame_url) ?? undefined,
    usage: { completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0 },
  };
}

/** 取不到时必须报可读错误（判据 9），不要静默返回空 */
export function requireVideoResult(payload: unknown): ExtractedVideoResult {
  const result = extractVideoResult(payload);
  if (!result) {
    throw new VideoError('unknown', '无法从响应中定位视频地址（响应结构未验证）', {
      detail: `已尝试 content[].video_url / content.video_url / 顶层 video_url；原始响应：${JSON.stringify(
        payload,
      ).slice(0, 400)}`,
    });
  }
  return result;
}

export interface ExtractedTaskId {
  task_id: string;
  /** 实际命中的字段路径（`id` / `task_id` / `data.id`） */
  id_path: string;
}

/**
 * 创建响应里的任务 ID。
 * 任务书只确证了 SDK 里叫 `create_result.id`；HTTP 响应体的字段名**未验证**，
 * 因此依次试 `id` / `task_id` / `data.id`，并记录命中路径。
 */
export function extractTaskId(payload: unknown): ExtractedTaskId | null {
  const root = asRecord(payload);
  if (!root) return null;

  const direct = pickUrl(root.id) ?? pickUrl(root.task_id);
  if (direct) return { task_id: direct, id_path: pickUrl(root.id) ? 'id' : 'task_id' };

  const nested = asRecord(root.data);
  const nestedId = pickUrl(nested?.id) ?? pickUrl(nested?.task_id);
  if (nestedId) return { task_id: nestedId, id_path: 'data.id' };

  return null;
}

export function requireTaskId(payload: unknown): ExtractedTaskId {
  const result = extractTaskId(payload);
  if (!result) {
    throw new VideoError('unknown', '创建任务成功但响应里找不到任务 ID（字段名未验证）', {
      detail: `已尝试 id / task_id / data.id；原始响应：${JSON.stringify(payload).slice(0, 400)}`,
    });
  }
  return result;
}
