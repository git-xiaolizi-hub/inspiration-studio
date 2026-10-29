/**
 * 主动补测节点尺寸（M5b3）。
 *
 * **为什么需要这一层**：xyflow 只把"节点有多宽多高、端口在哪"记在
 * `nodeLookup.get(id).measured` / `.internals.handleBounds` 里，而这两样**只由
 * ResizeObserver 的回调写入**（`@xyflow/react` 的 `useNodeObserver` → `store.updateNodeInternals`）。
 * 边能不能画出来，取决于 `getEdgePosition` 里的这道门（`@xyflow/system` 的 `isNodeInitialized`）：
 *
 *     !!(node.internals.handleBounds || node.handles?.length) && !!(node.measured.width || node.width)
 *
 * 门不过就 `return null`，`EdgeWrapper` 随即 `return null` —— **节点照画、端口照在、
 * 边一条都不渲染，控制台也不报错**。而 ResizeObserver 的回调是**按帧投递**的：
 * 页面不出帧时（窗口被遮挡/最小化、后台标签页、无帧调度的无头窗口、被 embed 的 webview）
 * 回调永远不来，`measured` 就一直是空对象。
 *
 * 所以这里在每次 nodes 变化后补一刀：谁还没被量过，就直接读 DOM 的
 * offsetWidth/offsetHeight 走同一个 `updateNodeInternals`（这条路径不依赖帧）。
 * 量过的节点不重复处理，正常环境下等于空转。
 *
 * 为什么要重试：xyflow 的 nodes 是两段式的 —— 组件先渲染（此时还不是新节点），
 * `StoreUpdater` 的 effect 再把新 nodes 写进它自己的 store，然后才画出新的节点 DOM。
 * 第一次尝试常常"节点数据有了、DOM 还没有"，所以最多重试 8 次（每次 30ms，用 setTimeout
 * 而不是 requestAnimationFrame —— 没帧的时候 rAF 根本不会跑）。
 */

import { useEffect } from 'react';
import { useStoreApi } from '@xyflow/react';

interface MeasuredLike {
  measured?: { width?: number; height?: number };
}

/** 需要补测的节点 id：在 RF 的 nodeLookup 里还没有 `measured.width` 的那些 */
export function unmeasuredNodeIds(
  ids: readonly string[],
  lookup: { get: (id: string) => MeasuredLike | undefined },
): string[] {
  return ids.filter((id) => {
    const node = lookup.get(id);
    // lookup 里还没有（刚提交、StoreUpdater 尚未同步）也算待补：updateNodeInternals 会自己跳过不存在的
    return !node || !(node.measured?.width && node.measured?.height);
  });
}

const MAX_ATTEMPTS = 8;
const RETRY_MS = 30;

export interface EnsureNodesMeasuredProps {
  /** 当前节点 id 列表（来自 store，页面本来就在订阅） */
  ids: readonly string[];
}

export function EnsureNodesMeasured({ ids }: EnsureNodesMeasuredProps) {
  const store = useStoreApi();

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled || attempt >= MAX_ATTEMPTS) return;
      timer = setTimeout(run, RETRY_MS);
    };

    const run = () => {
      attempt += 1;
      const state = store.getState();
      const domNode = state.domNode;
      if (!domNode || ids.length === 0) return;

      const pending = unmeasuredNodeIds(ids, state.nodeLookup as never);
      if (pending.length === 0) return;

      const elements = new Map<string, Element>();
      domNode.querySelectorAll('.react-flow__node').forEach((element) => {
        const id = element.getAttribute('data-id');
        if (id) elements.set(id, element);
      });

      const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>();
      for (const id of pending) {
        const element = elements.get(id);
        if (element) updates.set(id, { id, nodeElement: element as HTMLDivElement, force: true });
      }
      // 节点 DOM 还没画出来（两段式提交的第一段）→ 下一拍再来
      if (updates.size === 0) return schedule();

      // 直接走 store（不用 useUpdateNodeInternals：那个包了一层 requestAnimationFrame，正是没帧时不会跑的东西）
      state.updateNodeInternals(updates);

      // 还没量全（例如某些节点是这一拍才插进 DOM 的）→ 再补一次
      if (unmeasuredNodeIds(ids, store.getState().nodeLookup as never).length > 0) schedule();
    };

    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ids, store]);

  return null;
}
