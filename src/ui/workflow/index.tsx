/**
 * 工作流模块的唯一出口。
 *
 * 解耦契约（任务书 §0）：`App.tsx` 只有一行懒加载引用这一整个目录。
 * 删掉 `src/ui/workflow/` 就等于删掉这个功能 —— 主应用其余部分不需要任何改动
 * （`vite.config.ts` 里那个"可选模块兜底"插件负责让缺失的懒加载不炸构建）。
 */

import { ReactFlowProvider } from '@xyflow/react';
import { WorkflowPage } from './WorkflowPage';

export default function WorkflowPageEntry() {
  return (
    <ReactFlowProvider>
      <WorkflowPage />
    </ReactFlowProvider>
  );
}
