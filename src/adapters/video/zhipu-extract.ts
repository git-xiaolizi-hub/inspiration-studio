/**
 * 智谱查询响应的防御式提取（M4c §3：「SUCCESS 时结果 URL 的**字段位置未确认**」）。
 *
 * 所以和 Ark 一样：按几种最可能的形态依次试，**命中路径写进 `url_path`**，
 * 真跑一次之后就能把多余分支砍掉。宁可多试一条路径，也不假装知道。
 *
 * 三种形态（顺序即优先级）：
 *   ① `video_result[0].url`（数组元素是对象；元素是字符串也认）
 *   ② `data.video_result[0].url`（被网关包了一层）
 *   ③ 顶层 `video_url`（字符串或 `{url}`）/ `video_result.url`
 *
 * 任务 ID 不在这里重复实现：创建响应同样是 `{ id }`，
 * 直接复用 `extract.ts` 的 `requireTaskId`（它已经会试 `id` / `task_id` / `data.id` 并记录路径）。
 */
import { VideoError } from './errors';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

/** 从"可能是字符串、可能是 {url}、可能是 {video_url}"的东西里挖出 URL */
function pickUrl(value: unknown): string | null {
  const direct = asHttpUrl(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return asHttpUrl(record.url) ?? asHttpUrl(record.video_url) ?? null;
}

/** `video_result` 可能是数组、单个对象、或一个 URL 字符串 */
function fromVideoResult(container: unknown, prefix: string): ExtractedZhipuResult | null {
  if (Array.isArray(container)) {
    for (let index = 0; index < container.length; index += 1) {
      const url = pickUrl(container[index]);
      if (url) return { video_url: url, url_path: `${prefix}[${index}].url` };
    }
    return null;
  }
  const url = pickUrl(container);
  if (url) return { video_url: url, url_path: `${prefix}.url` };
  return null;
}

export interface ExtractedZhipuResult {
  video_url: string;
  /** 实际命中的响应路径，例如 `video_result[0].url` */
  url_path: string;
}

export function extractZhipuVideoResult(payload: unknown): ExtractedZhipuResult | null {
  const root = asRecord(payload);
  if (!root) return null;

  const direct = fromVideoResult(root.video_result, 'video_result');
  if (direct) return direct;

  const data = asRecord(root.data);
  if (data) {
    const nested = fromVideoResult(data.video_result, 'data.video_result');
    if (nested) return nested;
  }

  const top = asHttpUrl(root.video_url) ?? pickUrl(root.video_url);
  if (top) return { video_url: top, url_path: 'video_url' };

  return null;
}

export function requireZhipuVideoResult(payload: unknown): ExtractedZhipuResult {
  const result = extractZhipuVideoResult(payload);
  if (!result) {
    throw new VideoError('unknown', '无法从响应中定位视频地址（智谱响应结构未验证）', {
      detail:
        '已尝试 video_result[].url / data.video_result[].url / 顶层 video_url；' +
        `原始响应：${JSON.stringify(payload).slice(0, 400)}`,
      nextStepOverride:
        '把这条原始响应发给承接方，改 zhipu-extract.ts 一处即可；任务 ID 仍可用 /async-result/{id} 重新查询',
    });
  }
  return result;
}
