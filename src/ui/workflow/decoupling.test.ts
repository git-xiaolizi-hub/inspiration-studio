/**
 * 解耦判据（任务书 §0 / §6-6）：
 * - `App.tsx` 里对工作流模块的引用**只有一行**懒加载；
 * - `src/ui/workflow/` 之外没有任何代码 import 这个模块；
 * - 那行之前的注释明确写了"目录可被整块删除"，构建兜底在 vite.config.ts。
 *
 * 这里用 grep 而不是渲染断言：渲染只能证明"现在能跑"，grep 才能证明"删掉就能走"。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const WORKFLOW_DIR = join(ROOT, 'src', 'ui', 'workflow');
const APP = join(ROOT, 'src', 'ui', 'App.tsx');

function walk(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

describe('工作流模块可整块删除（解耦）', () => {
  it('App.tsx 里只有一行引用 ui/workflow，且是 lazy() 懒加载', () => {
    const lines = readFileSync(APP, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('ui/workflow'));

    // 注释里也会提到目录名，所以先只看代码行
    const codeLines = lines.filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    expect(codeLines).toHaveLength(1);
    expect(codeLines[0]).toContain("lazy(() => import('./ui/workflow'))");
  });

  it('工作流目录之外没有任何文件 import 这个模块', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((file) => !file.startsWith(WORKFLOW_DIR))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /(from|import)\s*\(?\s*['"][^'"]*ui\/workflow/.test(source);
      })
      .map((file) => relative(ROOT, file).replace(/\\/g, '/'));

    expect(offenders).toEqual(['src/ui/App.tsx']);
  });

  it('App.tsx 那一行带 ts-ignore（目录被删时 tsc 不会因为找不到模块失败）', () => {
    const source = readFileSync(APP, 'utf8');
    const index = source.indexOf("import('./ui/workflow')");
    expect(index).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, index - 400), index);
    expect(before).toContain('@ts-ignore');
  });

  it('vite.config.ts 有"可选模块"兜底插件（缺失时构建仍能过）', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain('optional-ui-modules');
    expect(config).toContain("const TARGET = 'ui/workflow'");
  });

  it('工作流目录里没有任何网络级依赖（不引 CDN 样式/字体）', () => {
    const files = walk(WORKFLOW_DIR).filter((file) => !/\.test\.(ts|tsx)$/.test(file));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, relative(ROOT, file)).not.toMatch(/https?:\/\/[^\s'"]+\.(css|woff2?|ttf)/);
    }
    // 目录本身必须存在，否则这条用例失去意义
    expect(statSync(WORKFLOW_DIR).isDirectory()).toBe(true);
  });
});
