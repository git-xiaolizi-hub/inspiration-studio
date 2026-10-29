/**
 * 通道能力描述（M4c）。
 *
 * 为什么要单独一个文件：UI 需要"按通道禁用不支持的表单"，而**能力是适配器的事实**、
 * 不是 UI 的猜测。把它放在这里（只依赖类型，不 import 任何适配器），
 * 这样面板既能拿到默认能力，又不会因为 import `channels.ts`（它会构造适配器）而形成环。
 *
 * 纪律：`false` 的项必须**在 UI 里禁用并说明原因**，同时在适配器里**显式抛错**。
 * 两处都做，是因为用户可能绕过 UI（或 UI 漏了一处），而"静默降级"是明令禁止的。
 */
import type { VideoResolution } from './types';

export interface VideoChannelCapabilities {
  /** false = 免费通道：预估显示「免费」，成功后不计入累计花费 */
  paid: boolean;
  supportsReferenceVideo: boolean;
  supportsAudioReference: boolean;
  /** 「参考图角色」（character/scene/style）；首尾帧是另一个能力 */
  supportsImageReference: boolean;
  supportsKeyframes: boolean;
  supportsDraftMode: boolean;
  /**
   * 首尾帧从哪来：`file` = 本地文件（Ark 可 base64）；
   * `url` = 只能填公网 URL（智谱只接受 http(s) 图片地址，data URL 未验证）
   */
  keyframeSource: 'file' | 'url';
  /** 本地允许的分辨率；不在列表里的直接拒绝，不发那次必然失败的请求 */
  resolutions: VideoResolution[];
  /** '4-30' = 4–30 秒或 -1（Ark 口径）；'5' = 固定 5 秒（免费通道不询问时长） */
  durations: '4-30' | '5';
}

/** Ark Seedance 2.5：CHARTER §4 的完整能力面 */
export const PAID_CHANNEL_CAPABILITIES: VideoChannelCapabilities = {
  paid: true,
  supportsReferenceVideo: true,
  supportsAudioReference: true,
  supportsImageReference: true,
  supportsKeyframes: true,
  supportsDraftMode: true,
  keyframeSource: 'file',
  resolutions: ['480p', '720p', '1080p'],
  durations: '4-30',
};

/**
 * 智谱 CogVideoX-Flash（免费）：
 * - 没有 `reference_video` 能力 → 不支持视频参考；
 * - 只有 `image_url`（单图或首尾两图），没有"参考图角色"语义 → 只支持首尾帧；
 * - 没有样片（Draft）概念 → 不支持 draft_mode；
 * - 分辨率上限按「只确信 1280x720 这一个例值」处理：480p/720p 放行，1080p 本地拒绝（见报告§4）。
 */
export const FREE_CHANNEL_CAPABILITIES: VideoChannelCapabilities = {
  paid: false,
  supportsReferenceVideo: false,
  supportsAudioReference: false,
  supportsImageReference: false,
  supportsKeyframes: true,
  supportsDraftMode: false,
  keyframeSource: 'url',
  resolutions: ['480p', '720p'],
  durations: '5',
};

/** 降级提示统一从这里出，避免 UI 里三次写不同的说法 */
export function unsupportedCapabilityHint(
  capability: keyof Pick<
    VideoChannelCapabilities,
    'supportsReferenceVideo' | 'supportsAudioReference' | 'supportsImageReference' | 'supportsDraftMode'
  >,
): string {
  switch (capability) {
    case 'supportsReferenceVideo':
      return '免费通道不支持视频参考（切到 Seedance 可用）';
    case 'supportsAudioReference':
      return '免费通道不支持音频参考（免费模型出的是无声视频）';
    case 'supportsImageReference':
      return '免费通道只认首帧/尾帧，不支持「参考图角色」（切到 Seedance 可用）';
    case 'supportsDraftMode':
      return '免费通道没有样片模式（Draft 是 Seedance 的能力）';
    default:
      return '当前通道不支持这个参数';
  }
}
