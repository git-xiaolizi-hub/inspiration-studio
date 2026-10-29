/**
 * 视频能力守卫（**P2 改语义**）。
 *
 * ── 旧不变量（M4b→P0.5，已作废）────────────────────────────────────
 * 「视频模块能整块删掉，只需改 3 行已知代码（App.tsx 的 import + Route、设置页的 Link）。」
 *
 * ── 为什么作废 ───────────────────────────────────────────────────
 * P2 把 `/video` 独立页删了（委托方：「视频页是冗余，应该加入单卡创作」），
 * 视频能力改成**单卡创作的「生视频」tab**。所以「整块删掉不伤主流程」这个前提不再成立：
 * 删掉 `src/adapters/video/` 与 `src/ui/video/` 会让单卡创作少一个核心 tab，这是功能损失，
 * 不是解耦成功。继续按旧判据写，只会逼着人把守卫删掉。
 *
 * ── 新不变量 ─────────────────────────────────────────────────────
 * 1. **引用点必须收敛到已知白名单**：`src/` 下（除两个定义目录）对视频模块的 import，
 *    逐文件、逐行地等于下面 WHITELIST 里那一组，多一行少一行都红；
 * 2. **不存在独立视频页**：没有 `VideoPage` 组件、没有 `/video` 路由、
 *    没有 `to="/video"` 这类入口（App.tsx 的路由表另行逐条比对，恰好 8 条）；
 * 3. 白名单涉及的**文件清单**本身也被断言 —— 它就是「要动视频能力时必须改哪些文件」的答案。
 *
 * 这一条**不许**退化成「只要有引用就算过」：那种写法等于把守卫删掉。
 *
 * ── 为什么定义目录内部不扫 ─────────────────────────────────────
 * `src/adapters/video/`（适配器）与 `src/ui/video/`（面板 / 生视频区块）是**模块本身**，
 * 它们互相引用是定义的一部分，不算「散落」。守卫盯的是**消费侧**。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const APP_REL = 'src/ui/App.tsx';
const SETTINGS_REL = 'src/ui/pages/SettingsPage.tsx';
const CREATE_REL = 'src/ui/create/CreatePage.tsx';

/** 定义侧：模块自己。内部的互相引用不算泄漏。 */
const DEFINITION_DIRS = ['src/adapters/video/', 'src/ui/video/'];

/** 消费侧：`src/` 下除定义目录以外的一切 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const posix = (file: string) => file.split('\\').join('/');

const consumerFiles = (): string[] =>
  walk(join(ROOT, 'src'))
    .map((file) => posix(relative(ROOT, file)))
    .filter((rel) => !DEFINITION_DIRS.some((prefix) => rel.startsWith(prefix)));

/** 一条「引用视频模块」的 import（只认 import 语句里的模块路径，避免把散文注释算进来） */
const VIDEO_IMPORT = /from\s+['"][^'"]*video\/[^'"]*['"]/;

/** 独立视频页的痕迹：组件名 / 路由声明 / 入口链接 / 跳转串 */
const VIDEO_PAGE_TRACE = /(VideoPage|path=["']\/video["']|to=["']\/video["']|\/video\?)/;

interface Ref {
  file: string;
  line: string;
}

/**
 * 白名单：消费侧对视频模块的**全部** import，逐条给出它为什么必须存在。
 *
 * 1. `src/ui/create/CreatePage.tsx` —— 单卡创作的「生视频」tab 就是它渲染的。
 *    这是 P2 之后视频能力**面向用户的唯一入口**，删了就没有视频功能。
 * 2. `src/ui/workflow/WorkflowRuntime.ts`（4 行）—— 工作流画板的「生视频」节点：
 *    提交任务要 `adapterForModel` + `VideoTaskRunner`，参考素材要 `isPublicHttpUrl`，
 *    请求参数的类型来自 `types`。
 * 3. `src/ui/workflow/cost.ts`（2 行）—— 画板在跑之前要报价：按模型判断免费/付费
 *    （`isFreeVideoModel`）、并按价格表里的族名取单价（`PRICE_TABLE_MODEL_NAME`）。
 * 4. `src/ui/workflow/m5b4b.test.ts`（2 行）—— 画板「可指定模型 / 中间产物可审核」那九条
 *    判据要用真的能力位与真适配器装配，属测试替身，不是产品入口。
 * 5. `src/adapters/shared/cors-adapters.test.ts`（1 行）—— 跨厂商错误分类的回归测试，
 *    只借 `classifyVideoFailure` 验「429 / 内容审核 / 鉴权」这三种错误在浏览器里怎么翻译。
 */
const WHITELIST: ReadonlyArray<Ref> = [
  {
    file: 'src/adapters/shared/cors-adapters.test.ts',
    line: "import { classifyVideoFailure } from '../video/errors';",
  },
  {
    file: 'src/ui/create/CreatePage.tsx',
    line: "import { VideoGenerationSection } from '../video/VideoGenerationSection';",
  },
  {
    file: 'src/ui/workflow/cost.ts',
    line: "import { adapterKindForModel, isFreeVideoModel } from '../../adapters/video/channels';",
  },
  {
    file: 'src/ui/workflow/cost.ts',
    line: "import { PRICE_TABLE_MODEL_NAME } from '../../adapters/video/constants';",
  },
  {
    file: 'src/ui/workflow/m5b4b.test.ts',
    line: "import { FREE_CHANNEL_CAPABILITIES, PAID_CHANNEL_CAPABILITIES } from '../../adapters/video/capabilities';",
  },
  {
    file: 'src/ui/workflow/m5b4b.test.ts',
    line: "import { adapterForModel as videoAdapterForModel } from '../../adapters/video/channels';",
  },
  {
    file: 'src/ui/workflow/WorkflowRuntime.ts',
    line: "} from '../../adapters/video/channels';",
  },
  {
    file: 'src/ui/workflow/WorkflowRuntime.ts',
    line: "import { isPublicHttpUrl } from '../../adapters/video/media';",
  },
  {
    file: 'src/ui/workflow/WorkflowRuntime.ts',
    line: "import { VideoTaskRunner } from '../../adapters/video/task-runner';",
  },
  {
    file: 'src/ui/workflow/WorkflowRuntime.ts',
    line: "import type { VideoGenerationRequest, VideoResolution } from '../../adapters/video/types';",
  },
];

/** 实际扫到的引用（顺序无关，比较前统一排序） */
function actualRefs(): Ref[] {
  const rows: Ref[] = [];
  for (const rel of consumerFiles()) {
    const lines = readFileSync(join(ROOT, rel), 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (VIDEO_IMPORT.test(trimmed)) rows.push({ file: rel, line: trimmed });
    }
  }
  return rows;
}

const key = (ref: Ref) => `${ref.file} :: ${ref.line}`;
const sorted = (refs: ReadonlyArray<Ref>) => refs.map(key).sort();

describe('视频能力：引用点收敛 + 没有独立视频页', () => {
  it('消费侧对视频模块的 import 恰好等于白名单（多一处就说明又散落了一处）', () => {
    // 用排序后的字符串数组比较：失败时 vitest 会逐条列出「多了什么 / 少了什么」
    expect(sorted(actualRefs())).toEqual(sorted(WHITELIST));
  });

  it('白名单涉及的只有 5 个文件（这就是「改视频能力时必须动的文件清单」）', () => {
    expect([...new Set(WHITELIST.map((ref) => ref.file))].sort()).toEqual([
      'src/adapters/shared/cors-adapters.test.ts',
      'src/ui/create/CreatePage.tsx',
      'src/ui/workflow/WorkflowRuntime.ts',
      'src/ui/workflow/cost.ts',
      'src/ui/workflow/m5b4b.test.ts',
    ]);
  });

  it('消费侧没有 VideoPage / /video 路由 / /video 入口的痕迹', () => {
    const offenders = consumerFiles().filter((rel) =>
      VIDEO_PAGE_TRACE.test(readFileSync(join(ROOT, rel), 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });

  it('VideoPage 组件两个可能的位置都不存在（旧页在 src/ui/video/，更早的约定在 src/ui/pages/）', () => {
    expect(existsSync(join(ROOT, 'src/ui/video/VideoPage.tsx'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/ui/pages/VideoPage.tsx'))).toBe(false);
  });

  it('App.tsx 的路由表恰好 9 条（+ 兜底），且其中没有 /video', () => {
    const source = readFileSync(join(ROOT, APP_REL), 'utf-8');
    const paths = [...source.matchAll(/<Route[\s\S]{0,80}?path="([^"]+)"/g)].map(
      (match) => match[1],
    );

    // 末尾的 `*` 是兜底路由（访问 #/video 落到「页面不存在」靠它，不许删）
    // P3：八个页面变九个 —— 新增 `/studio`（写作工作台），`/canvas` 留成重定向，页面数仍是 8。
    expect(paths).toEqual([
      '/',
      '/records/:id',
      '/settings',
      '/ai-config',
      '/model-guide',
      '/canvas',
      '/studio',
      '/workflow',
      '/create',
      '*',
    ]);
    expect(paths.filter((path) => path !== '*')).toHaveLength(9);
    expect(paths).not.toContain('/video');
  });

  it('App.tsx 与设置页零视频引用（入口只剩创作页那一条）', () => {
    for (const rel of [APP_REL, SETTINGS_REL]) {
      const source = readFileSync(join(ROOT, rel), 'utf-8');
      expect({ file: rel, import: VIDEO_IMPORT.test(source) }).toEqual({ file: rel, import: false });
      expect({ file: rel, trace: VIDEO_PAGE_TRACE.test(source) }).toEqual({ file: rel, trace: false });
    }
  });

  it('创作页确实渲染了生视频区块（白名单那一行不是死引用）', () => {
    const source = readFileSync(join(ROOT, CREATE_REL), 'utf-8');
    expect(source).toContain('<VideoGenerationSection');
    // 视频 tab 仍在（四个 tab 的 id 里必须有 video）
    expect(source).toMatch(/id: 'video'/);
  });

  it('package.json 里有 test:video-adapter（判据脚本名固定）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['test:video-adapter']).toBe('vitest run src/adapters/video src/ui/video');
  });
});
