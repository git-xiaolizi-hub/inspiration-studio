/**
 * 文本拼接（M2.5）：把转写结果并进已有正文。
 *
 * 契约要求「不覆盖已有文字，追加并留空行」。这里只做纯字符串处理，
 * 方便单测覆盖各种空白/空值情况；真正的落库仍走 M2 的 updateRecord。
 */

/** 规整转写文本：去掉首尾空白，把内部连续空行压成一个换行 */
export function normalizeTranscript(raw: string): string {
  return (raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 追加到已有正文：已有内容为空则直接返回转写文本；否则在原正文后留一个空行再接上。
 * 不修改已有文字（包括末尾空格以外的任何内容）。
 */
export function appendTranscript(existing: string, transcript: string): string {
  const addition = normalizeTranscript(transcript);
  if (!addition) return existing;
  const base = (existing ?? '').replace(/[ \t]+$/, '');
  if (base.trim() === '') return addition;
  return `${base}\n\n${addition}`;
}
