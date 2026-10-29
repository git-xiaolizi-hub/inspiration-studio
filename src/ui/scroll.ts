/**
 * 回到页面顶部（P1.5 §3）。
 *
 * 委托人报的现象：「在点击卡片后，再点击导航栏的首页不会直接回到首页」。
 * 实测路由是对的（从详情页点「首页」确实回到 `#/`），真正的问题是两件事：
 *   1. **已经在首页**且滚到中间时点「首页」没有任何反应 —— 路由没变，
 *      NavLink 不会重挂载任何组件，所以必须由 onClick 自己滚；
 *   2. 从详情页返回后列表**保留了旧滚动位置**，看起来「像没动」——
 *      新页面挂载时滚一次顶部即可。
 *
 * 两个调用点：`App.tsx` 的顶栏「首页」onClick、`RecordListPage` 的挂载 effect。
 *
 * 为什么是 `behavior: 'auto'` 而不是 `'smooth'`：委托人要的是「点了就到」，
 * 平滑动画在长列表上要滑一秒，反而像没反应。
 * 为什么不做成全局 hashchange 监听：那会把别的页面（设置页 / AI 配置页）的
 * 滚动位置也一起清掉，属于「用一个新 bug 换一个旧 bug」。
 */
export function scrollToTop(): void {
  try {
    if (typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      return;
    }
    document.documentElement.scrollTop = 0;
  } catch {
    /* 极老环境 / 测试环境没有 scrollTo 时忽略：滚动位置不影响任何功能 */
  }
}
