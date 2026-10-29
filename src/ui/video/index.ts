/**
 * 视频 UI 出口。
 *
 * P2 起这里**没有页面**了：`/video` 独立页被删（委托方：视频页是冗余，应该加入单卡创作），
 * 视频能力以 `VideoGenerationSection` 的形式挂在 `/#/create?recordId=xxx` 的「生视频」tab 里：
 *
 * ```tsx
 * import { VideoGenerationSection } from '../video/VideoGenerationSection';
 * <VideoGenerationSection catalog={...} priceTable={...} spent={...} budgetLimit={...} />
 * ```
 *
 * `VideoGenerationPanel` 是更底层的面板（只看适配器 + 能力位，不管模型表），
 * 单卡创作走 Section，直接驱动状态机的测试走 Panel。
 */
export { VideoGenerationPanel } from './VideoGenerationPanel';
export type { VideoGenerationPanelProps } from './VideoGenerationPanel';
export { VideoGenerationSection, VIDEO_MODEL_EMPTY_HINT } from './VideoGenerationSection';
export type { VideoGenerationSectionProps } from './VideoGenerationSection';
