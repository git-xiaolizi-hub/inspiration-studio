import { describe, expect, it } from 'vitest';
import { appendTranscript, normalizeTranscript } from './transcript';

describe('转写文本拼接（追加不覆盖）', () => {
  it('正文为空时直接写入转写文本', () => {
    expect(appendTranscript('', '梦到一片海')).toBe('梦到一片海');
    expect(appendTranscript('   \n\n ', '梦到一片海')).toBe('梦到一片海');
  });

  it('已有正文时追加，并留一个空行', () => {
    expect(appendTranscript('标题：海边', '梦到一片海')).toBe('标题：海边\n\n梦到一片海');
  });

  it('不改动已有文字（含内部换行与标点）', () => {
    const existing = '第一行\n第二行，有标点。';
    expect(appendTranscript(existing, '新内容')).toBe(`${existing}\n\n新内容`);
  });

  it('转写结果首尾空白、连续空行会被规整', () => {
    expect(appendTranscript('正文', '  你好\n\n\n世界  ')).toBe('正文\n\n你好\n世界');
  });

  it('转写为空时不产生多余空行', () => {
    expect(appendTranscript('正文', '   ')).toBe('正文');
    expect(appendTranscript('', '')).toBe('');
  });

  it('normalizeTranscript 只做规整，不删内容', () => {
    expect(normalizeTranscript('a\r\nb\r\n\r\nc')).toBe('a\nb\nc');
    expect(normalizeTranscript('  a  ')).toBe('a');
  });
});
