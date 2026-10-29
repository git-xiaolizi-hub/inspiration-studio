/**
 * 请求体构造（**形状全部照抄任务书 §3，未给的字段一律不加**）。
 *
 * 官方确证的部分：
 * - `POST {base}/contents/generations/tasks`，body 里 `content` 是数组，`role` 只有四个值；
 * - 顶层可选：`ratio` / `duration`(4–30 或 -1) / `resolution` / `draft` / `watermark` /
 *   `generate_audio` / `omni_reference_task_type`；
 * - Draft：`draft=true` 时只支持 480p（设别的分辨率会报错）；
 * - 基于 Draft 出成片：`content` 里放 `{type:'draft_task', draft_task:{id}}`，分辨率只能 1080p
 *   （`ark-seedance-2.5.txt`「Step2:生成正式视频」）。
 *
 * 未验证的部分（报告里已列）：
 * - 音频素材的 content item 形状：官方只在"参数复用表"里提到 `content.audio_url`，
 *   没有给完整 JSON 示例 → 这里实现成 `{type:'audio_url', audio_url:{url}}`，**标注未验证**。
 */
import {
  DRAFT_FINAL_RESOLUTION,
  DRAFT_RESOLUTION,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
} from './constants';
import { VideoError } from './errors';
import { isPublicHttpUrl, resolveMediaRef } from './media';
import type { MediaAsset, VideoGenerationRequest } from './types';

export type ArkRole = 'reference_image' | 'first_frame' | 'last_frame' | 'reference_video';

export interface ArkContentItem {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url' | 'draft_task';
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  draft_task?: { id: string };
  role?: ArkRole;
}

export interface ArkTaskPayload {
  model: string;
  content: ArkContentItem[];
  ratio?: string;
  duration?: number;
  resolution?: string;
  draft?: boolean;
  watermark?: boolean;
  generate_audio?: boolean;
  omni_reference_task_type?: 'auto';
}

export interface BuildOptions {
  model: string;
  watermark?: boolean;
  generateAudio?: boolean;
}

interface RefSource {
  url?: string;
  asset?: MediaAsset;
}

function assertDuration(duration: number | -1): void {
  if (duration === -1) return;
  if (!Number.isFinite(duration) || duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) {
    throw new VideoError(
      'duration_conflict',
      `时长 ${String(duration)} 不合法：只能是 ${MIN_DURATION_SEC}–${MAX_DURATION_SEC} 秒，或 -1（模型自选）`,
      { detail: '本地校验先拦一道，避免提交后才收到异步报错' },
    );
  }
}

/**
 * 一份素材 → 请求体里 `url` 字段的字符串。
 * 优先用 `asset`（适配器自己按体积分流 → base64 或 URL），其次用现成的 `url`：
 * - 视频：只接受公网 http(s)；
 * - 图片/音频：公网 http(s) 或已经编码好的 `data:` URL（UI 若已转好可直接传）。
 */
export function refFor(kind: MediaAsset['kind'], source: RefSource | string): string {
  if (typeof source === 'string') return stringRef(kind, source);
  if (source.asset) {
    const resolved = resolveMediaRef(source.asset);
    // 类型不符（例如把音频塞进 image_url）在 resolveMediaRef 里已经拦掉了
    if (resolved.kind !== kind) {
      throw new VideoError('invalid_media', `素材类型不符：需要 ${kind}，拿到 ${resolved.kind}`);
    }
    return resolved.ref;
  }
  if (!source.url) {
    throw new VideoError('invalid_media', '素材既没有 url 也没有 asset，无法放进请求体');
  }
  return stringRef(kind, source.url);
}

function stringRef(kind: MediaAsset['kind'], raw: string): string {
  const url = raw.trim();
  if (!url) throw new VideoError('invalid_media', '素材地址为空');
  if (url.startsWith('data:')) {
    if (kind === 'video') {
      throw new VideoError('media_needs_public_url', '视频不能走 base64/data URL，必须是公网 URL');
    }
    if (!/^data:(image|audio)\//i.test(url)) {
      throw new VideoError('invalid_media', `data URL 的类型不对：${url.slice(0, 40)}`);
    }
    return url;
  }
  if (!isPublicHttpUrl(url)) {
    throw new VideoError('media_needs_public_url', `素材地址不是公网 http(s) URL：${url.slice(0, 80)}`, {
      detail: '本地文件请构造 MediaAsset（带 bytes）交给适配器转 base64，或先上传到对象存储/图床',
    });
  }
  return url;
}

export function buildTaskPayload(req: VideoGenerationRequest, options: BuildOptions): ArkTaskPayload {
  const prompt = req.prompt.trim();
  const hasRefs =
    (req.references?.images?.length ?? 0) > 0 ||
    (req.references?.videos?.length ?? 0) > 0 ||
    (req.references?.audio?.length ?? 0) > 0 ||
    (req.keyframes?.length ?? 0) > 0;

  if (!prompt && !hasRefs) {
    throw new VideoError('unknown', '提示词为空且没有任何素材：至少给一句画面描述');
  }

  assertDuration(req.params.duration);

  const content: ArkContentItem[] = [];
  if (prompt) content.push({ type: 'text', text: prompt });

  // 顺序按任务书 §3 的示例：text → 参考图 → 首帧 → 尾帧 → 参考视频（→ 音频）
  for (const image of req.references?.images ?? []) {
    content.push({
      type: 'image_url',
      image_url: { url: refFor('image', image) },
      role: 'reference_image',
    });
  }

  for (const frame of req.keyframes ?? []) {
    if (frame.position !== 'first' && frame.position !== 'last') {
      throw new VideoError(
        'unknown',
        `关键帧 position=${String(frame.position)} 无法映射：官方只确证 first_frame / last_frame 两个角色`,
        { detail: '第 n 个关键帧的传法未经验证，先不要让用户踩这个坑' },
      );
    }
    content.push({
      type: 'image_url',
      image_url: { url: refFor('image', { url: frame.image_url, asset: frame.asset }) },
      role: frame.position === 'first' ? 'first_frame' : 'last_frame',
    });
  }

  for (const video of req.references?.videos ?? []) {
    content.push({
      type: 'video_url',
      video_url: { url: refFor('video', video) },
      role: 'reference_video',
    });
  }

  // ⚠️ 未验证：音频 item 形状（官方只在参数复用表里提到 content.audio_url）
  for (const audio of req.references?.audio ?? []) {
    content.push({
      type: 'audio_url',
      audio_url: { url: refFor('audio', audio) },
    });
  }

  const draft = req.params.draft_mode === true;
  // 官方：Draft 只支持 480p，设别的分辨率会报错 → 第一步直接钉成 480p，
  // 而不是让用户提交后才收到异步报错（第二步的分辨率限制见 buildDraftFinalizePayload）。
  const payload: ArkTaskPayload = {
    model: options.model,
    content,
    ratio: req.params.ratio,
    duration: req.params.duration,
    resolution: draft ? DRAFT_RESOLUTION : req.params.resolution,
    draft,
    watermark: options.watermark ?? false,
    generate_audio: options.generateAudio ?? true,
  };

  // 视频编辑/续写类任务需要 auto（任务书 §3）；有参考视频时才带上，纯文生视频不加
  if ((req.references?.videos?.length ?? 0) > 0) {
    payload.omni_reference_task_type = 'auto';
  }

  return payload;
}

/**
 * 样片第二步：基于 Draft 任务 ID 出成片。
 * 官方只支持 1080p；提示词与参考素材由服务端自动复用（不要再传一遍）。
 */
export function buildDraftFinalizePayload(draftTaskId: string, options: BuildOptions): ArkTaskPayload {
  if (!draftTaskId.trim()) {
    throw new VideoError('unknown', '缺少 Draft 任务 ID，无法出成片');
  }
  return {
    model: options.model,
    content: [{ type: 'draft_task', draft_task: { id: draftTaskId.trim() } }],
    resolution: DRAFT_FINAL_RESOLUTION,
    draft: false,
    watermark: options.watermark ?? false,
  };
}
