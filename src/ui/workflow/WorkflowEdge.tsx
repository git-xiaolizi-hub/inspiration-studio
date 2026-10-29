/**
 * 自定义连线（M5b2 §3 的删除路径之二：连线 hover 出中点 ×）。
 *
 * 为什么要自定义：xyflow 默认边只有一条 path，没有"中点按钮"这种容器。
 * `EdgeLabelRenderer` 是官方的做法 —— 它把任意 React 节点渲染在边坐标系的同一个
 * transform 里，缩放平移跟着走，不需要自己算屏幕坐标。
 *
 * hover 判定用一条 20px 宽的透明 path（和 xyflow 自带的 interaction path 同一思路），
 * 否则"鼠标要精确压在 2px 的线上"这个体验会让人以为不能删。
 */

import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { useWorkflowStore } from './store';

export function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        d={path}
        className="wf-edge-hit"
        fill="none"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={selected ? 'wf-edge-selected' : undefined}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`nodrag nopan wf-edge-delete${hovered || selected ? ' is-visible' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title="删除这条连线"
          aria-label="删除连线"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={(event) => {
            event.stopPropagation();
            removeEdge(id);
          }}
        >
          ×
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const workflowEdgeTypes = { workflow: WorkflowEdge };
