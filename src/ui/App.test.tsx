import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';

// 让 React 18 认为当前是测试环境，避免 act 警告
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  window.location.hash = '';
});

/** 在指定 hash 路由下挂载整个应用，返回渲染出的文本 */
function renderAt(hash: string): string {
  window.location.hash = hash;
  root = createRoot(container);
  act(() => {
    root?.render(<App />);
  });
  return container.textContent ?? '';
}

describe('空壳路由可正常渲染', () => {
  it('默认进入记录列表页', () => {
    expect(renderAt('')).toContain('记录列表');
  });

  it('/ai-config 渲染 AI 配置页', () => {
    // M1 时这条断言锁的是占位文案「M3 实现」；M3 已实现页面，占位文案随之消失，
    // 因此改为断言实现后的真实内容（报告 §4.1 记录了这一处既有断言的更新）。
    // M3R 又把「厂商预设按钮」改成「厂商 tab + 连接 + 模型表」，所以这里的
    // 「厂商预设」随之换成「厂商」（见 M3R-REPORT §删改断言清单）。
    const text = renderAt('#/ai-config');
    expect(text).toContain('AI 配置');
    expect(text).toContain('厂商');
  });

  it('/model-guide 渲染选型文档页（含最后更新与视频算例）', () => {
    const text = renderAt('#/model-guide');
    expect(text).toContain('怎么选厂商与模型');
    expect(text).toContain('最后更新：2026-10');
    expect(text).toContain('¥45.36');
  });

  it('/canvas 重定向到 /studio（P3 把画布整页换成写作工作台，旧书签不许 404）', () => {
    // P3 之前这条断言锁的是画布页的「卡片墙 / 瀑布流」。画布已被授权替换，
    // 断言随之改为「落到新页面」—— 强度不变：仍是真渲染，仍要求不是兜底页。
    const text = renderAt('#/canvas');
    expect(text).toContain('写作工作台');
    expect(text).toContain('素材');
    expect(text).not.toContain('页面不存在');
  });

  it('/records/:id 渲染详情页并读到路由参数', () => {
    const text = renderAt('#/records/n-42');
    expect(text).toContain('记录详情');
    expect(text).toContain('n-42');
  });
});
