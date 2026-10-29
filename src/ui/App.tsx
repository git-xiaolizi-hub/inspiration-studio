import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { AIConfigPage } from './pages/AIConfigPage';
import { ModelGuidePage } from './pages/ModelGuidePage';
import { RecordDetailPage } from './pages/RecordDetailPage';
import { RecordListPage } from './pages/RecordListPage';
import { SettingsPage } from './pages/SettingsPage';
import { StudioPage } from './pages/StudioPage';
import { CreateRoute } from './create/CreatePage';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { scrollToTop } from './scroll';

/**
 * 可选模块（M5b 工作向画板）。**全应用对它的唯一引用就是下面这一行。**
 *
 * 「可选」是 CHARTER 的定义：这块可以整块删掉而不影响其余功能。为此：
 * - 注释掉 `tsc` 的模块解析错误（目录被删时那行 import 解析不到）；
 * - `vite.config.ts` 的 `optional-ui-modules` 插件在模块缺失时兜底成一个空组件，
 *   使 `mv src/ui/workflow <别处> && npm run build` 仍然 exit 0。
 * 目录存在时两者都不介入，类型照常检查、产物照常打包。
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- 目录可被整块删除（M5b §0 判据）
// @ts-ignore TS2307: 模块存在时正常解析；缺失时由构建期兜底
const WorkflowPage = lazy(() => import('./ui/workflow'));

/**
 * 应用外壳 + 路由表。
 * 用 HashRouter：纯前端、无后端，打包成桌面应用或直接打开 dist/index.html 都不需要服务端重写规则。
 * 整个应用运行时零网络请求（无 CDN、无字体、无接口），所以断网刷新照常可用。
 */
export function App() {
  const online = useOnlineStatus();

  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="app">
        <header className="app-header">
          <h1>灵感工坊</h1>
          <nav className="app-nav" aria-label="主导航">
            {/*
              D2 决议：顶栏只留三项。原来那六项（记录 / 设置 / AI 配置 / 画布 / 画板 / 视频）
              没被删——它们搬到了 设置页的「创作工具」「模型与厂商」两个区块，
              下面 <Routes> 里的八个路由一个都没少（上一轮曾误删 /model-guide）。
              P2 授权删掉的就是 `/video` 一个：视频能力并进了单卡创作的生视频 tab，
              九个路由因此变成八个。改这里时**只改导航渲染，不许动 <Routes>**。
            */}
            {/*
              点「首页」要真的回到列表顶部（P1.5 §3）：
              onClick 负责「已经在首页」的情形（路由没变，不会重挂载，只能自己滚）；
              RecordListPage 的挂载 effect 负责「从别的页面过来」的情形。两处都是行为开关的效果。
            */}
            <NavLink to="/" end onClick={scrollToTop}>
              首页
            </NavLink>
            <NavLink to="/create">创作</NavLink>
            <NavLink to="/settings">设置</NavLink>
          </nav>
        </header>

        {!online && (
          <p className="offline-banner" role="status">
            当前离线：应用完全本地运行，记录、录音、导入导出都照常可用。
          </p>
        )}

        <main className="app-main">
          <Routes>
            <Route path="/" element={<RecordListPage />} />
            <Route path="/records/:id" element={<RecordDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/ai-config" element={<AIConfigPage />} />
            <Route path="/model-guide" element={<ModelGuidePage />} />
            <Route path="/canvas" element={<Navigate to="/studio" replace />} />
            {/* P3：写作工作台（替换 M5a 的画布）。/canvas 保留为重定向 —— 旧书签不许 404 */}
            <Route path="/studio" element={<StudioPage />} />
            <Route
              path="/workflow"
              element={
                <Suspense fallback={<p className="placeholder">正在加载画板…</p>}>
                  <WorkflowPage />
                </Suspense>
              }
            />
            <Route path="/create" element={<CreateRoute />} />
            <Route path="*" element={<p className="placeholder">页面不存在</p>} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
