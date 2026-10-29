import { useEffect, useState } from 'react';
import { DEFAULT_THEME, THEMES } from '../../core/theme';
import type { ThemeName } from '../../core/theme';
import { loadThemeSetting, saveThemeSetting, subscribeTheme } from '../../core/theme/session';
import type { ThemeSetting } from '../../core/theme/session';

/**
 * 外观主题（P1.5）：四个**具名**选项，一组互斥单选。
 *
 * 委托人原话：「主题中的『跟随系统』似乎没有必要了，影响美观，不如直接给用户
 * 展示主题名称吧：柔和奶油、罗兰梦境、霓虹深空、暖夜琥珀」。
 *
 * 所以这里没有「深浅 / 气质」两维度了 —— 那是内部矩阵（见 core/theme），
 * 用户只需要在四个名字里挑一个。名字与顺序都来自 `THEMES`，不在这里抄一份。
 */

export function ThemeSection({
  initial,
  onSaved,
}: {
  initial?: ThemeSetting | null;
  onSaved?: (setting: ThemeSetting) => void;
} = {}) {
  const [setting, setSetting] = useState<ThemeSetting | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 订阅：备份导入会经由 applyThemeSetting 广播过来，
    // 面板上的选中态因此不需要「刷新页面」才对。
    const unsubscribe = subscribeTheme((next) => {
      if (!cancelled) setSetting(next);
    });
    (async () => {
      try {
        const loaded = await loadThemeSetting();
        if (!cancelled && loaded) setSetting(loaded);
      } catch {
        // 读不到就用外面传进来的 / 默认值，不打断设置页其它区块
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function choose(theme: ThemeName): Promise<void> {
    setError(null);
    try {
      const saved = await saveThemeSetting(theme);
      setSetting(saved);
      onSaved?.(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '主题保存失败');
    }
  }

  const theme: ThemeName = setting?.theme ?? DEFAULT_THEME;

  return (
    <section className="card" data-block="theme">
      <h3>外观主题</h3>
      <p className="settings-block-sub">四套配色，点一下就换</p>

      <div className="theme-choices" role="group" aria-label="主题">
        {THEMES.map((option) => (
          <label className="theme-option" key={option.name}>
            <input
              type="radio"
              name="theme"
              value={option.name}
              checked={theme === option.name}
              onChange={() => void choose(option.name)}
            />
            <span className="theme-option-label">
              <i
                className="theme-swatch"
                aria-hidden="true"
                style={{ background: option.swatch }}
              />
              {option.label}
            </span>
            <span className="theme-option-hint">{option.description}</span>
          </label>
        ))}

        {/* 预留位：后续加主题时换成真选项（委托人 2026-10-28「增加两个空选项占位」）。
            不是 radio、不可点，只占一格，避免将来加主题时整块布局重排。 */}
        {[0, 1].map((slot) => (
          <div className="theme-option is-placeholder" key={`soon-${slot}`} aria-disabled="true">
            <span className="theme-option-label">
              <i className="theme-swatch is-empty" aria-hidden="true" />
              敬请期待
            </span>
            <span className="theme-option-hint">更多配色还在路上</span>
          </div>
        ))}
      </div>

      {error && <p className="error small">{error}</p>}
    </section>
  );
}
