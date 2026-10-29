/**
 * AI 配置页（路由 `/ai-config`）。
 * 具体实现都在 `src/ui/ai-config/` 下（M3 约定：AI 相关 UI 统一放 `src/ui/ai-*`）。
 */
import { AIConfigPanel } from '../ai-config/AIConfigPanel';

export function AIConfigPage() {
  return <AIConfigPanel />;
}
