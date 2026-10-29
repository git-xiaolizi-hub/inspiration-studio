import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { initTheme } from './core/theme/session';
import './ui/tokens.css'; // 必须在 styles.css 之前：令牌要先于组件样式定义
import './ui/styles.css';

// 主题（M7 起；P1.5 改为四套具名主题、不再跟随系统）：
// index.html 的内联脚本已按 localStorage 抢先设好 <html data-theme>；
// 这里以 settings 表（IndexedDB）为准纠正一次（旧 {scheme,mood} 数据也在这条路径上折算成主题）。
// 不 await：首屏不等 IndexedDB。
void initTheme();

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点，index.html 可能被改动');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 离线外壳：只在生产构建注册（开发时注册会被旧缓存困住，改一行代码都要手动清 SW）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 注册失败不影响主流程：应用本身零网络依赖，只是少了"断网硬刷新"的兜底
    });
  });
}
