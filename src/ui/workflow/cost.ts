/**
 * 成本闸门（CHARTER §13.2 硬约束）。
 *
 * 只用既有公式：图片走 `estimateImage` + `imagePriceFor`，视频走 `estimateVideo`，
 * **不在这里复制任何单价或 token 公式**。这里只做三件事：
 * 1. 把节点的 data（模型 / 分辨率 / 时长）翻译成公式的入参；
 * 2. 给出同屏必须展示的口径（未录入价格、倍率、视频"停止不阻止计费"）；
 * 3. 生成对话框里那一行字（任务书 §4 的固定格式）。
 */

import {
  FREE_TRIAL_PRICE_TABLE,
  estimateImage,
  estimateVideo,
  formatYuan,
} from '../../adapters/ai-models/pricing';
import type { PriceTable } from '../../adapters/ai-models/pricing';
import { imagePriceFor } from '../../adapters/image/channels';
import { adapterKindForModel, isFreeVideoModel } from '../../adapters/video/channels';
import { PRICE_TABLE_MODEL_NAME } from '../../adapters/video/constants';
import type { CostQuote } from './executor';
import type { ExecNode } from './types';

export interface QuoteContext {
  priceTable: PriceTable;
  /** 当前厂商连接的计费倍率（1 = 官方价） */
  multiplier?: number;
  /** 图片张数（画板固定 1 张：节点 = 一次生成） */
  imageCount?: number;
}

/** 视频节点的默认参数（节点里没选时）：最便宜的一档 */
export const DEFAULT_VIDEO_RESOLUTION = '480p' as const;
export const DEFAULT_VIDEO_SECONDS = 5;

const VIDEO_STOP_NOTICE = '本地「停止」不会阻止服务端继续跑并计费';
const VIDEO_ESTIMATE_NOTICE = '金额为估算值；真实扣费以接口返回的 usage.completion_tokens 反算为准';

export function quoteForNode(node: ExecNode, ctx: QuoteContext): CostQuote | null {
  const modelId = (node.data.modelId ?? '').trim();
  if (modelId === '') return null; // 没选模型 → 交给 runX 报可执行错误

  if (node.type === 'image') {
    const count = ctx.imageCount ?? 1;
    const info = imagePriceFor(modelId, ctx.priceTable);
    const estimate = estimateImage({ count, priceRow: info.row });
    const notices: string[] = [];
    if (info.row?.note) notices.push(info.row.note);
    if (estimate.error) notices.push(`${estimate.error}：本次按 ¥0.00 预扣，实际以账单为准`);
    if (info.row === null || info.row.perImage === null) {
      notices.push('价格表未录入这个模型的图片单价，建议先在「AI 配置 → 价格」里补上');
    }
    return {
      nodeId: node.id,
      kind: 'image',
      amount: estimate.total,
      modelId,
      spec: `${count} 张`,
      free: info.free && (info.row?.perImage ?? 0) === 0,
      notices,
    };
  }

  if (node.type === 'video') {
    const resolution = node.data.resolution ?? DEFAULT_VIDEO_RESOLUTION;
    const seconds = node.data.durationSec ?? DEFAULT_VIDEO_SECONDS;
    const free = isFreeVideoModel(modelId);
    const table = free ? FREE_TRIAL_PRICE_TABLE : ctx.priceTable;
    // 价格表按"族名"记价（doubao-seedance-2.5），接口按版本化 id 调用 —— 归一与 video/channels 同源
    const priceModel =
      free || adapterKindForModel(modelId) === 'ark' ? PRICE_TABLE_MODEL_NAME : modelId;
    const estimate = estimateVideo({
      model: priceModel,
      res: resolution,
      outSec: seconds,
      inVideoSec: 0,
      draft: false,
      table,
      multiplier: free ? 1 : ctx.multiplier,
    });
    const notices: string[] = [];
    if (estimate.error) notices.push(`${estimate.error}：本次按 ¥0.00 预扣，实际以账单为准`);
    if (!free && (ctx.multiplier ?? 1) !== 1) {
      notices.push(`金额已按连接倍率 ×${ctx.multiplier} 换算（官方价 × 倍率）`);
    }
    notices.push(VIDEO_STOP_NOTICE);
    notices.push(VIDEO_ESTIMATE_NOTICE);
    return {
      nodeId: node.id,
      kind: 'video',
      amount: free ? 0 : estimate.total,
      modelId,
      spec: `${seconds} 秒 · ${resolution}`,
      free,
      notices,
    };
  }

  return null;
}

/**
 * 对话框主文案（任务书 §4 的固定格式）：
 * `本次将花费 ≈¥X.XX（<模型名> <规格>），继续？`
 */
export function costConfirmText(quote: CostQuote): string {
  if (quote.free) {
    return `本次免费（${quote.modelId} ${quote.spec}），继续？`;
  }
  return `本次将花费 ≈${formatYuan(quote.amount)}（${quote.modelId} ${quote.spec}），继续？`;
}
