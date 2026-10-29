/**
 * 通用模态框（R6）。
 *
 * 为什么抽出来：本轮有三处需要「问一句再继续」的地方 ——
 * 语音切「仅作记录」/ 切回「本地模型」、云端 STT 的配置、生视频的花费确认。
 * 三处都必须是**页面内弹窗**（不是 `window.confirm`）：
 * 原生确认框会被浏览器当弹窗拦、不能带中文按钮、也没法截图留证。
 *
 * 样式复用 styles.css 里既有的 `.modal-backdrop` / `.modal`（首次启动的引导弹窗就用它），
 * 只补了 `.modal-actions` / `.modal-sub`，没有新建样式文件。
 *
 * R7b 扩了三个**可选**属性（缺省行为与 R6 完全一致，既有弹窗一个字没动）：
 * - `maxWidth`：推荐配置要 760px（默认仍是 560px 的 `.modal` 宽度）；
 * - `scrollBody`：正文可滚动、底部按钮固定（`.modal-split`），
 *   三组连接展开后正文会很高，不能让按钮被顶出屏幕；
 * - `bodyClassName`：正文容器的附加类名（给两块新弹窗排版用）。
 */
import { useEffect, useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface DialogAction {
  label: string;
  onClick: () => void;
  /** primary = 主操作（继续 / 下载并使用）；ghost = 取消类 */
  kind?: 'primary' | 'ghost';
  disabled?: boolean;
  /** 测试与自动化定位用（可选） */
  testId?: string;
}

interface Props {
  open: boolean;
  /** 顶部标题 */
  title: string;
  /** 读屏用的对话框名（缺省用 title） */
  label?: string;
  children?: ReactNode;
  actions: DialogAction[];
  /** Esc / 点遮罩 = 取消 */
  onDismiss: () => void;
  /** R7b：弹窗最大宽度（px）。缺省 = `.modal` 的 560px */
  maxWidth?: number;
  /** R7b：正文独立滚动 + 底部按钮固定 */
  scrollBody?: boolean;
  /** R7b：正文容器的附加类名 */
  bodyClassName?: string;
}

export function Dialog({
  open,
  title,
  label,
  children,
  actions,
  onDismiss,
  maxWidth,
  scrollBody,
  bodyClassName,
}: Props) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onDismiss]);

  if (!open) return null;

  const style: CSSProperties | undefined =
    maxWidth === undefined ? undefined : { maxWidth: `${maxWidth}px` };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label ?? title}
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        // 只在点到遮罩本身（不是冒泡上来的卡片内点击）时关闭
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div className={`modal${scrollBody ? ' modal-split' : ''}`} style={style}>
        <h2 id={titleId}>{title}</h2>
        {scrollBody ? (
          <div className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
        ) : (
          children
        )}
        <div className="modal-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              data-testid={action.testId}
              className={`button ${action.kind === 'primary' ? 'primary' : 'ghost'}`}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
