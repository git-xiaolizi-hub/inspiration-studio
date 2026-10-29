/**
 * 汇率取用（界面侧）。首帧用缓存，挂载后异步刷新一次。
 *
 * 刷新**不写任何用户配置**：新汇率只会成为「下次切到国外按量时的默认值」，
 * 已经填好的倍率保持不动（用户改过的数字不能被网络请求悄悄覆盖）。
 */
import { useEffect, useState } from 'react';
import { readFxCache, refreshFx, type FxSnapshot } from '../../core/fx';

export function useUsdCny(enabled = false): FxSnapshot {
  const [snapshot, setSnapshot] = useState<FxSnapshot>(readFxCache);

  useEffect(() => {
    // 只有真的要用到汇率（配了「国外按量」）才联网：没配之前不该发任何请求
    if (!enabled) return;
    const controller = new AbortController();
    let alive = true;
    void refreshFx({ signal: controller.signal }).then((next) => {
      if (alive) setSnapshot(next);
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [enabled]);

  return snapshot;
}
