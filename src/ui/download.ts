/**
 * 文件下载：导出 zip 走 `<a download>` + ObjectURL，全程不碰剪贴板（硬约束 4）。
 * jsdom 里没有真实的下载行为，测试不会调用它。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('当前环境不支持文件下载');
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 在部分浏览器会让下载中断，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
