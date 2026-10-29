/**
 * 预估桥接：把"视频请求"接到 M3 的 `estimateVideo`（判据要求复用，不重写公式）。
 *
 * 这里只做三件 M3 不知道的事：
 * 1. 样片模式下**成片分辨率只能是 1080p**（官方限制）→ 预估按 1080p 算，并给出提示；
 * 2. Draft 只支持 480p（官方限制）→ 与 M3 的 draft 语义一致，不需改写；
 * 3. 输入视频秒数要么来自请求里的参考视频（长度未知），要么由 UI 问用户。
 */
import { estimateVideo, draftAdvice, draftLines, shouldShowMinTokenNotice, MIN_TOKEN_NOTICE } from '../ai-models/pricing';
import type { PriceTable, VideoEstimate, VideoResolution } from '../ai-models/pricing';
import { DRAFT_FINAL_RESOLUTION } from './constants';
import type { VideoGenerationRequest } from './types';

export interface EstimateRequestInput {
  request: VideoGenerationRequest;
  priceTable: PriceTable;
  /** 价格表里的模型族名（`doubao-seedance-2.5`），不是版本化模型 ID */
  priceModel: string;
  /** 参考视频的秒数（未知就填 0；填 > 0 才会走"含输入视频"单价并触发最低用量提示） */
  inVideoSec?: number;
  /**
   * 计费倍率（M3R4 §4.2）：来自 AI 配置里该厂商当前连接的「倍率」，默认 1 = 官方价。
   * 官方单价 × 倍率 = 实付估算；≠1 时会在 notices 里明说，不悄悄改数。
   */
  multiplier?: number;
}

export interface RequestEstimate {
  estimate: VideoEstimate;
  /** 样片两行金额（Draft / 成片），非样片模式为 null */
  lines: { draft: string; final: string } | null;
  advice: string | null;
  /** 必须原样展示的提示（官方限制 / 估算口径） */
  notices: string[];
  /** 实际用于预估的成片分辨率（样片模式被钉成 1080p） */
  effectiveResolution: VideoResolution;
}

export function estimateVideoRequest(input: EstimateRequestInput): RequestEstimate {
  const { request, priceTable, priceModel } = input;
  const draft = request.params.draft_mode === true;
  const requestedRes = request.params.resolution;
  const effectiveResolution: VideoResolution =
    draft && requestedRes !== DRAFT_FINAL_RESOLUTION ? DRAFT_FINAL_RESOLUTION : requestedRes;

  const estimate = estimateVideo({
    model: priceModel,
    res: effectiveResolution,
    outSec: request.params.duration === -1 ? 5 : request.params.duration,
    inVideoSec: input.inVideoSec ?? 0,
    draft,
    table: priceTable,
    multiplier: input.multiplier,
  });

  const notices: string[] = [];
  const multiplier = estimate.multiplier ?? 1;
  if (multiplier !== 1) {
    notices.push(
      `金额已按连接倍率 ×${multiplier} 换算（官方价 × 倍率 = 实付估算）；倍率在「AI 配置 → 连接」里改`,
    );
  }
  if (draft && requestedRes !== DRAFT_FINAL_RESOLUTION) {
    notices.push(
      `样片模式：第一步只有 480p（官方限制），第二步出成片只能 1080p —— 已按 1080p 预估，你选的 ${requestedRes} 在样片模式下用不了`,
    );
  }
  if (request.params.duration === -1) {
    notices.push('时长选了「模型自选」(-1)：预估按 5 秒示例计算，真实扣费以接口返回的 usage.completion_tokens 为准');
  }
  if (shouldShowMinTokenNotice(estimate)) {
    notices.push(MIN_TOKEN_NOTICE);
  }
  notices.push('金额为估算值；真实扣费以接口返回的 usage.completion_tokens 反算为准');

  return {
    estimate,
    lines: draftLines(estimate),
    advice: draftAdvice(estimate),
    notices,
    effectiveResolution,
  };
}
