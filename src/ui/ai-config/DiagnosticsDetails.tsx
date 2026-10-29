/**
 * 「技术细节」折叠块（M3R §6）。
 *
 * 硬要求：必须有 `METHOD URL` / `HTTP 状态` / `耗时 ms` / `error.name` /
 * 响应前 200 字，以及「这条动作试过哪些地址」。
 * 主提示永远是人话（`userMessage`），这里只负责让人排查。
 */
import type { HttpDiagnostics } from '../../adapters/ai-models/client';

export interface DiagnosticsDetailsProps {
  /** 动作名：「连通性自检」/「拉取模型列表」——两个动作各给一份，不混用 */
  action: string;
  diagnostics?: HttpDiagnostics;
  /** 原始错误信息（AIError.message） */
  rawMessage?: string;
  testId?: string;
}

export function DiagnosticsDetails({ action, diagnostics, rawMessage, testId }: DiagnosticsDetailsProps) {
  const method = diagnostics?.method || '—';
  const url = diagnostics?.url || '—';
  const status = diagnostics ? diagnostics.status : 0;
  return (
    <details data-testid={testId} className="diagnostics">
      <summary>技术细节（{action}）</summary>
      <ul>
        <li>
          <span className="diag-key">请求</span>
          <code>{`${method} ${url}`}</code>
        </li>
        <li>
          <span className="diag-key">HTTP 状态</span>
          <code>{status === 0 ? '未拿到响应' : String(status)}</code>
        </li>
        <li>
          <span className="diag-key">耗时</span>
          <code>{`${diagnostics?.elapsedMs ?? 0} ms`}</code>
        </li>
        <li>
          <span className="diag-key">error.name</span>
          <code>{diagnostics?.errorName || '—'}</code>
        </li>
        <li>
          <span className="diag-key">响应前 200 字</span>
          <code className="diag-body">{diagnostics?.bodyPreview ? diagnostics.bodyPreview : '（空）'}</code>
        </li>
        {diagnostics && diagnostics.attemptedUrls.length > 1 ? (
          <li>
            <span className="diag-key">已尝试地址</span>
            <code>{diagnostics.attemptedUrls.join(' → ')}</code>
          </li>
        ) : null}
        {rawMessage ? (
          <li>
            <span className="diag-key">原始信息</span>
            <code>{rawMessage}</code>
          </li>
        ) : null}
      </ul>
    </details>
  );
}
