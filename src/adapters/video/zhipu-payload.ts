/**
 * 智谱 CogVideoX-Flash 的请求体构造 + **能力裁剪校验**（M4c §4.1）。
 *
 * 与 `payload.ts`（Ark）刻意分开：两家的字段名、字段集、素材语义都不一样，
 * 硬塞进同一个构造器只会让两边都变成 `if (provider === ...)` 的泥球。
 * 报告 §5 里"哪些层能共用"的结论就是从这里来的。
 *
 * 三条纪律：
 * 1. **只发任务书 §3 确认过的字段**（`model` / `prompt` / `quality` / `size` / `fps` /
 *    `with_audio` / `movement_amplitude` / `image_url` / `duration?`）；
 * 2. **不支持的参数显式抛错**（`unsupported_capability`），绝不静默丢掉；
 * 3. 非法值（分辨率/时长/素材形态）**本地先拒**，省一次必然失败的请求（免费额度也值得省）。
 */
import { VideoError } from './errors';
import { isPublicHttpUrl } from './media';
import {
  ZHIPU_DOCUMENTED_SIZE,
  ZHIPU_DURATION_CHOICES,
  ZHIPU_FIXED_DURATION,
  ZHIPU_SUPPORTED_RESOLUTIONS,
  zhipuSizeFor,
} from './zhipu-constants';
import type { VideoGenerationRequest } from './types';

export type ZhipuQuality = 'speed' | 'quality';
export type ZhipuMovement = 'auto' | 'small' | 'medium' | 'large';

export interface ZhipuTaskPayload {
  model: string;
  prompt: string;
  quality: ZhipuQuality;
  size: string;
  fps: number;
  with_audio: boolean;
  movement_amplitude: ZhipuMovement;
  /** 单图 = 首帧；数组 = [首帧, 尾帧]（任务书 §3：「也可传数组」） */
  image_url?: string | string[];
  /** 默认不传（是否被该模型接受未验证） */
  duration?: number;
}

export interface ZhipuBuildOptions {
  model: string;
  quality?: ZhipuQuality;
  fps?: number;
  withAudio?: boolean;
  movementAmplitude?: ZhipuMovement;
  /** 是否把 duration 写进请求体；默认 false */
  sendDuration?: boolean;
}

const SUPPORTED = new Set<string>(ZHIPU_SUPPORTED_RESOLUTIONS);

/**
 * 只接受公网 http(s) 图片地址。
 * 智谱**是否接受 data URL 未验证**，所以本地直接拒绝并给出可执行下一步，
 * 而不是"试试看"（失败会浪费一次排队，还可能被告知参数非法）。
 */
function requirePublicImageUrl(url: string, label: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new VideoError('invalid_media', `${label}为空`);
  }
  if (trimmed.startsWith('data:')) {
    throw new VideoError(
      'media_needs_public_url',
      `免费通道只接受公网 http(s) 图片地址，不接受 data URL（智谱是否支持 data URL 未验证）`,
      {
        detail: `${label}是一张 ${trimmed.slice(0, 24)}… 的内联图片`,
        nextStepOverride:
          '先把图片传到可公网访问的地址（图床 / 对象存储公共读），再把 URL 填进来；或切换到 Seedance（支持 < 5MB 图片走 base64）',
      },
    );
  }
  if (!isPublicHttpUrl(trimmed)) {
    throw new VideoError(
      'media_needs_public_url',
      `免费通道只接受公网 http(s) 图片地址：${trimmed.slice(0, 80)}`,
      {
        nextStepOverride:
          '先把图片传到可公网访问的地址（图床 / 对象存储公共读），再把 URL 填进来；或切换到 Seedance',
      },
    );
  }
  return trimmed;
}

/**
 * 关键帧地址：只接受公网 http(s)。
 * 本地文件（`asset`）在这里被**显式拒绝**——不是把 bytes 转 base64 硬塞过去
 * （智谱是否接受 data URL 未验证），也不是悄悄忽略这张图。
 */
function keyframeUrl(frame: { image_url?: string; asset?: unknown }, label: string): string {
  if (!frame.image_url && frame.asset) {
    throw new VideoError(
      'media_needs_public_url',
      `${label}是本地文件：免费通道只接受公网 http(s) 图片地址（data URL 未验证）`,
      {
        nextStepOverride:
          '先把这张图片传到可公网访问的地址（图床 / 对象存储公共读），再把 URL 填进首帧/尾帧；或切换到 Seedance（支持本地图片走 base64）',
      },
    );
  }
  return requirePublicImageUrl(frame.image_url ?? '', label);
}

/**
 * 能力裁剪：**在发请求之前**把所有免费通道做不到的事挡下来（判据 16 / 17）。
 * 报错文案必须一眼看出"这不是坏了，是这个通道没有这个能力 + 换哪个通道有"。
 */
export function assertZhipuSupported(req: VideoGenerationRequest): void {
  const videos = req.references?.videos ?? [];
  if (videos.length > 0) {
    throw new VideoError('unsupported_capability', '免费通道不支持视频参考，请切换到 Seedance', {
      detail: `请求里带了 ${videos.length} 条 references.videos（智谱没有 reference_video 能力）`,
      nextStepOverride: '免费通道不支持视频参考，请切换到 Seedance（付费 · 支持参考视频/视频编辑）',
    });
  }

  const audio = req.references?.audio ?? [];
  if (audio.length > 0) {
    throw new VideoError('unsupported_capability', '免费通道不支持音频参考，请切换到 Seedance', {
      detail: `请求里带了 ${audio.length} 条 references.audio（免费模型出的是无声视频）`,
      nextStepOverride: '免费通道不支持音频参考，请切换到 Seedance（付费 · 支持音频/对嘴）',
    });
  }

  const images = req.references?.images ?? [];
  if (images.length > 0) {
    throw new VideoError('unsupported_capability', '免费通道不支持参考图角色，请改用首帧/尾帧或切换到 Seedance', {
      detail: `请求里带了 ${images.length} 条 references.images（role 语义是 Seedance 的）`,
      nextStepOverride:
        '免费通道只有 image_url（单图=首帧，数组=[首帧,尾帧]），没有 character/scene/style 角色；' +
        '请改用「首帧/尾帧」或切换到 Seedance',
    });
  }

  if (req.params.draft_mode === true) {
    throw new VideoError('unsupported_capability', '免费通道不支持样片模式（draft_mode），请切换到 Seedance', {
      detail: '样片（Draft）是 Seedance 的两步出片机制，免费通道没有这个概念',
      nextStepOverride: '免费通道不支持样片模式，请切换到 Seedance（付费 · 支持 Draft 480p 试跑）',
    });
  }

  for (const frame of req.keyframes ?? []) {
    if (frame.position !== 'first' && frame.position !== 'last') {
      throw new VideoError(
        'unsupported_capability',
        `关键帧 position=${String(frame.position)} 无法映射：免费通道只认首帧/尾帧`,
        { nextStepOverride: '第 n 个关键帧的传法未验证；请只用「首帧」和「尾帧」两个位置' },
      );
    }
  }

  const prompt = req.prompt.trim();
  if (!prompt) {
    throw new VideoError('unknown', '免费通道需要提示词（官方示例里 prompt 是必填）');
  }

  if (!SUPPORTED.has(req.params.resolution)) {
    throw new VideoError(
      'duration_conflict',
      `免费通道不支持 ${req.params.resolution}：本地只放行 480p / 720p`,
      {
        detail: '1080p 是否被 cogvideox-flash 接受未验证（任务书只给了 1280x720 这个例值）',
        nextStepOverride: '免费通道最高 720p（1080p 是否支持未验证）；要 1080p 请切换到 Seedance',
      },
    );
  }
}

/** 时长：默认固定 5 秒且不写进请求体；显式 sendDuration 时只放行 5/10 */
export function assertZhipuDuration(duration: number | -1, sendDuration: boolean): void {
  if (duration === -1) {
    throw new VideoError('duration_conflict', '免费通道不支持「模型自选时长」（-1），请切换到 Seedance', {
      nextStepOverride: '免费通道固定 5 秒；-1（模型自选）是 Seedance 的能力',
    });
  }
  if (!sendDuration) {
    if (duration !== ZHIPU_FIXED_DURATION) {
      throw new VideoError(
        'duration_conflict',
        `免费通道固定 ${ZHIPU_FIXED_DURATION} 秒，收到 ${duration} 秒`,
        {
          detail: 'duration 是否被该模型接受未验证，默认不传（模型自选取 5 秒）',
          nextStepOverride: `免费通道固定 ${ZHIPU_FIXED_DURATION} 秒（duration 默认不传）；要 4–30 秒请切换到 Seedance`,
        },
      );
    }
    return;
  }
  if (!ZHIPU_DURATION_CHOICES.includes(duration)) {
    throw new VideoError(
      'duration_conflict',
      `免费通道只放行 ${ZHIPU_DURATION_CHOICES.join(' / ')} 秒，收到 ${duration} 秒`,
      { detail: '即使显式发送 duration，也只放行官方常见档位；其余值可能被拒' },
    );
  }
}

/**
 * 组装请求体。
 * **字段顺序与集合都是确定的**：判据 12 直接断言"body 只含确认过的字段"，
 * 所以这里不允许图省事把 `req` 整个展开进去。
 */
export function buildZhipuPayload(
  req: VideoGenerationRequest,
  options: ZhipuBuildOptions,
): ZhipuTaskPayload {
  assertZhipuSupported(req);
  const sendDuration = options.sendDuration === true;
  assertZhipuDuration(req.params.duration, sendDuration);

  const size = zhipuSizeFor(req.params.resolution, req.params.ratio);
  if (!size) {
    throw new VideoError(
      'duration_conflict',
      `免费通道没有 ${req.params.resolution} / ${req.params.ratio} 对应的 size`,
      {
        detail: `已收录的尺寸表见 zhipu-constants（只有 ${ZHIPU_DOCUMENTED_SIZE} 是任务书例值，其余为推导）`,
      },
    );
  }

  const first = req.keyframes?.find((frame) => frame.position === 'first');
  const last = req.keyframes?.find((frame) => frame.position === 'last');
  if (last && !first) {
    throw new VideoError('invalid_media', '只给了尾帧：免费通道需要首帧才能确定"从哪开始"', {
      nextStepOverride: '补一张「首帧」，或切换到 Seedance（支持单尾帧/多关键帧的工作流）',
    });
  }

  const payload: ZhipuTaskPayload = {
    model: options.model,
    prompt: req.prompt.trim(),
    quality: options.quality ?? 'speed',
    size,
    fps: options.fps ?? 30,
    with_audio: options.withAudio === true,
    movement_amplitude: options.movementAmplitude ?? 'auto',
  };

  if (first && last) {
    payload.image_url = [keyframeUrl(first, '首帧'), keyframeUrl(last, '尾帧')];
  } else if (first) {
    payload.image_url = keyframeUrl(first, '首帧');
  }

  if (sendDuration) payload.duration = req.params.duration;

  return payload;
}
