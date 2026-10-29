/**
 * P3 · AI 上下文构造（任务书 §3.3：`【素材1】…\n【素材2】…\n\n【正文】…`）。
 *
 * 这份测试锁的是**字符串本身**：报告 §4 要贴的「实际构造出来的上下文」就是这里的期望值，
 * 两边必须字字一致 —— 否则报告里的样例和代码就是两套东西。
 */
import { describe, expect, it } from 'vitest';
import {
  STUDIO_SYSTEM_PROMPT,
  buildStudioContext,
  buildStudioUserMessage,
  contextHint,
  materialLabel,
} from './context';

const MATERIALS = [
  { text: '凌晨三点的梦：一座会呼吸的图书馆，书页像潮水一样翻动。' },
  { text: '想把那段地铁里的声音做成一首歌，报站声当鼓点。' },
];

describe('buildStudioContext', () => {
  it('两条素材 + 正文 → 任务书约定的形状（素材各占一行，空一行接【正文】）', () => {
    expect(buildStudioContext(MATERIALS, '图书馆在呼吸。')).toBe(
      '【素材1】凌晨三点的梦：一座会呼吸的图书馆，书页像潮水一样翻动。\n' +
        '【素材2】想把那段地铁里的声音做成一首歌，报站声当鼓点。\n' +
        '\n' +
        '【正文】图书馆在呼吸。',
    );
  });

  it('没有素材时只留【正文】段（不写空的【素材1】）', () => {
    expect(buildStudioContext([], '只有正文。')).toBe('【正文】只有正文。');
  });

  it('素材全文不截断：长素材一个字都不少地进上下文', () => {
    const long = '梦'.repeat(500);
    const context = buildStudioContext([{ text: long }], '');
    expect(context.startsWith(`【素材1】${long}`)).toBe(true);
    expect(context).toContain('【正文】');
  });

  it('materialLabel 从 1 开始编号', () => {
    expect(materialLabel(0)).toBe('【素材1】');
    expect(materialLabel(2)).toBe('【素材3】');
  });
});

describe('buildStudioUserMessage', () => {
  it('有指令时接一段【要求】；指令为空时不加这一段', () => {
    const context = buildStudioContext(MATERIALS, '图书馆在呼吸。');

    expect(buildStudioUserMessage(MATERIALS, '图书馆在呼吸。', ' 接着写 200 字 ')).toBe(
      `${context}\n\n【要求】接着写 200 字`,
    );
    expect(buildStudioUserMessage(MATERIALS, '图书馆在呼吸。', '   ')).toBe(context);
  });
});

describe('界面文案', () => {
  it('contextHint：条数与样张的「会带上 2 条素材 + 正文全文」一致', () => {
    expect(contextHint(2, 428)).toBe('会带上 2 条素材 + 正文全文');
    expect(contextHint(1, 0)).toBe('会带上 1 条素材');
    expect(contextHint(0, 120)).toBe('会带上正文全文');
    expect(contextHint(0, 0)).toBe('还没有素材，也没有正文');
  });

  it('系统提示不出现产品内部代号（委托方要求文案禁内部名）', () => {
    expect(STUDIO_SYSTEM_PROMPT).not.toMatch(/IA-v2|P3|M5|inspiration-assistant/i);
  });
});
