/**
 * 八类自定义节点（M5b2：M5b 的 5 种 + 「文本合并」；M5b4：+ 图片源 / 视频源）。
 *
 * 交互约定：
 * - 节点内所有表单控件都带 `nodrag` class —— 否则 xyflow 会把"在输入框里拖动光标"
 *   当成"拖动节点"，这是 reactflow 最常见的坑；
 * - 每个端口都是**带 id 的 handle**（id = `ports.ts` 里的端口名），
 *   否则"接到哪个口"会在渲染层丢掉；
 * - 删除入口之一在这里：节点右上角 hover 出 `×`（另有键盘 Delete 与右键菜单）；
 * - **M5b4：每个节点跑完都把自己的结果显示在节点上**（文本前 200 字 / 图片缩略图 /
 *   视频首帧 + 链接）。全量结果在右侧检查器里（点节点打开）——"先看见，再能拦"。
 */

import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { downloadBlob } from '../download';
import { useWorkflowStore } from './store';
import type { FlowNode } from './store';
import { NODE_PORTS, PORT_TYPE_LABELS } from './ports';
import type { PortDef } from './ports';
import {
  checkSourceFile,
  formatSize,
  listSourceOptions,
  storeSourceFile,
} from './sources';
import type { SourceKind } from './sources';
import { NODE_TYPE_LABELS, PACK_IDS, PACK_LABELS, isPackId } from './types';

const STATUS_LABELS: Record<string, string> = {
  idle: '未运行',
  running: '运行中',
  ok: '完成',
  error: '失败',
  skipped: '已跳过',
};

/** 节点上摘要的字数上限（§3.1 的"前 200 字"） */
export const NODE_OUTPUT_PREVIEW_CHARS = 200;

/** 头部高度与端口行高（px）：handle 的 top 与端口标签共用同一套数字，避免错位 */
const HEAD_H = 34;
const PORT_TOP = 40;
const PORT_ROW = 18;

function portTop(index: number): number {
  return PORT_TOP + index * PORT_ROW + PORT_ROW / 2;
}

function StatusBadge({ status }: { status?: string }) {
  const value = status ?? 'idle';
  return (
    <span className={`wf-status wf-status-${value}`} data-status={value}>
      {STATUS_LABELS[value] ?? value}
    </span>
  );
}

/** 节点上的"自己那份结果"（§3.1）：摘要 / 缩略图 / 首帧 + 链接 */
function NodeOutputPreview({ data }: { data: FlowNode['data'] }) {
  const text = data.resultText ?? '';
  const mediaUrl = data.mediaUrl ?? '';
  const kind = data.mediaKind;

  if (text === '' && mediaUrl === '') return null;

  return (
    <div className="wf-node-output" data-testid="wf-node-output">
      {mediaUrl !== '' && kind === 'image' && (
        <img className="wf-node-thumb" src={mediaUrl} alt="这一步的图" />
      )}
      {mediaUrl !== '' && kind === 'video' && (
        <video
          className="wf-node-thumb"
          src={mediaUrl}
          muted
          playsInline
          preload="metadata"
          data-testid="wf-node-output-video"
        />
      )}
      {text !== '' && (
        <p className="wf-node-output-text">
          {text.slice(0, NODE_OUTPUT_PREVIEW_CHARS)}
          {text.length > NODE_OUTPUT_PREVIEW_CHARS ? '…' : ''}
        </p>
      )}
      {mediaUrl !== '' && (
        <a className="nodrag wf-node-output-link" href={mediaUrl} target="_blank" rel="noreferrer">
          看原图 / 原视频
        </a>
      )}
    </div>
  );
}

interface ShellProps {
  id: string;
  type: keyof typeof NODE_TYPE_LABELS;
  data: FlowNode['data'];
  inputs?: PortDef[];
  outputs?: PortDef[];
  onInspect?: () => void;
  /** 输出节点自己渲染结果，别再叠一份摘要 */
  showOutput?: boolean;
  children: React.ReactNode;
}

function NodeShell({
  id,
  type,
  data,
  inputs = [],
  outputs = [],
  onInspect,
  showOutput = true,
  children,
}: ShellProps) {
  const removeNodes = useWorkflowStore((state) => state.removeNodes);
  const openInspector = useWorkflowStore((state) => state.openInspector);

  return (
    <div
      className={`wf-node wf-node-${type}`}
      data-node-id={id}
      data-node-type={type}
      data-status={data.status ?? 'idle'}
      onDoubleClick={onInspect ?? (() => openInspector(id))}
    >
      <button
        type="button"
        className="nodrag nopan wf-node-delete"
        title="删除这个节点（连带它的连线）"
        aria-label="删除节点"
        onClick={(event) => {
          event.stopPropagation();
          removeNodes([id]);
        }}
      >
        ×
      </button>

      {/* 输入口：xyflow 的 handle 是绝对定位的，所以标签也按同一套数字绝对定位 */}
      {inputs.map((port, index) => (
        <Handle
          key={port.name}
          id={port.name}
          type="target"
          position={Position.Left}
          className={`wf-handle wf-handle-${port.type}`}
          style={{ top: `${portTop(index)}px` }}
          data-port={port.name}
          data-port-type={port.type}
        />
      ))}
      {inputs.map((port, index) => (
        <span
          key={`label-${port.name}`}
          className="wf-port-label wf-port-label-in"
          style={{ top: `${portTop(index) - 7}px` }}
        >
          {port.label}
          {port.required ? '' : '（选）'}
        </span>
      ))}

      <div className="wf-node-head" style={{ height: `${HEAD_H}px` }}>
        <span className="wf-node-title">{NODE_TYPE_LABELS[type]}</span>
        <StatusBadge status={data.status} />
      </div>
      <div
        className="wf-node-body"
        style={{ paddingTop: `${Math.max(8, inputs.length * PORT_ROW + 6)}px` }}
      >
        {children}
      </div>
      {showOutput && <NodeOutputPreview data={data} />}
      {data.warning && <p className="wf-node-warning">{data.warning}</p>}
      {data.error && <p className="wf-node-error">{data.error}</p>}

      {outputs.map((port, index) => (
        <Handle
          key={port.name}
          id={port.name}
          type="source"
          position={Position.Right}
          className={`wf-handle wf-handle-${port.type}`}
          style={{ top: `${portTop(index)}px` }}
          data-port={port.name}
          data-port-type={port.type}
        />
      ))}
      {outputs.map((port, index) => (
        <span
          key={`out-${port.name}`}
          className="wf-port-label wf-port-label-out"
          style={{ top: `${portTop(index) - 7}px` }}
        >
          {port.label}
        </span>
      ))}
    </div>
  );
}

export function SourceNode({ id, data }: NodeProps<FlowNode>) {
  const records = useWorkflowStore((state) => state.records);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const onPickRecord = (event: ChangeEvent<HTMLSelectElement>) => {
    const recordId = event.target.value;
    const picked = records.find((record) => record.id === recordId);
    updateNodeData(id, {
      recordId: recordId === '' ? undefined : recordId,
      text: picked ? picked.text : (data.text ?? ''),
    });
  };

  return (
    <NodeShell id={id} type="source" data={data} outputs={NODE_PORTS.source.outputs}>
      <label className="wf-field">
        <span>记录</span>
        <select className="nodrag wf-select" value={data.recordId ?? ''} onChange={onPickRecord}>
          <option value="">（直接写文本）</option>
          {records.map((record) => (
            <option key={record.id} value={record.id}>
              {record.text.trim().slice(0, 24) || '（空记录）'}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="nodrag wf-textarea"
        rows={4}
        placeholder="写一段文字，或从上面选一条记录"
        value={data.text ?? ''}
        onChange={(event) => updateNodeData(id, { text: event.target.value, recordId: undefined })}
      />
    </NodeShell>
  );
}

/** 「文本合并」：多对一必须显式（ComfyUI 也是 MergeTextLists / TextCombinerTwo 这种节点） */
export function MergeNode({ id, data }: NodeProps<FlowNode>) {
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const ports = NODE_PORTS.merge;

  return (
    <NodeShell
      id={id}
      type="merge"
      data={data}
      inputs={ports.inputs}
      outputs={ports.outputs}
    >
      <label className="wf-field">
        <span>分隔符</span>
        <input
          className="nodrag wf-input"
          value={data.separator ?? '\n\n'}
          placeholder="\n\n"
          onChange={(event) => updateNodeData(id, { separator: event.target.value })}
        />
      </label>
      <label className="wf-check">
        <input
          className="nodrag"
          type="checkbox"
          checked={data.labelParts === true}
          onChange={(event) => updateNodeData(id, { labelParts: event.target.checked })}
        />
        <span>加【素材N】标签</span>
      </label>
      <p className="wf-hint">按输入口 1→4 的顺序拼接；没接的口忽略。</p>
    </NodeShell>
  );
}

export function PackNode({ id, data }: NodeProps<FlowNode>) {
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const openInspector = useWorkflowStore((state) => state.openInspector);
  const options = useWorkflowStore((state) => state.models.text);
  const textDefault = useWorkflowStore((state) => state.textDefault);
  const packId = isPackId(data.packId) ? data.packId : 'dream-interpretation';
  const ports = NODE_PORTS.pack;

  const chosenModel = (data.modelId ?? '').trim();
  const chosen = options.find(
    (option) =>
      option.modelId === chosenModel &&
      (data.providerId === undefined || option.providerId === data.providerId),
  );
  /** 节点上那句小字：**实际会用的模型名**；没配就标黄（避免"以为用了 A 其实用了 B"） */
  const actual = chosen
    ? { text: chosen.label, warn: false }
    : chosenModel === ''
      ? textDefault
        ? { text: `默认：${textDefault.label}`, warn: false }
        : { text: '未配置模型', warn: true }
      : { text: `配置里找不到「${chosenModel}」`, warn: true };

  return (
    <NodeShell
      id={id}
      type="pack"
      data={data}
      inputs={ports.inputs}
      outputs={ports.outputs}
      onInspect={() => openInspector(id)}
    >
      <label className="wf-field">
        <span>提示词包</span>
        <select
          className="nodrag wf-select"
          value={packId}
          onChange={(event) => {
            const next = event.target.value;
            if (isPackId(next)) updateNodeData(id, { packId: next });
          }}
        >
          {PACK_IDS.map((item) => (
            <option key={item} value={item}>
              {PACK_LABELS[item]}
            </option>
          ))}
        </select>
      </label>

      {/* M5b4 §2：这个提示词包由哪个模型跑（默认跟随"当前默认文本模型"） */}
      <label className="wf-field">
        <span>模型</span>
        <select
          className="nodrag wf-select"
          data-testid="wf-pack-model"
          value={chosenModel}
          onChange={(event) => {
            const modelId = event.target.value;
            const picked = options.find((option) => option.modelId === modelId);
            updateNodeData(id, { modelId, providerId: picked?.providerId });
          }}
        >
          <option value="">
            {textDefault ? `跟随默认（${textDefault.label}）` : '（未配置模型）'}
          </option>
          {options.map((option) => (
            <option key={option.key} value={option.modelId}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p
        className={`wf-node-model ${actual.warn ? 'wf-node-model-warn' : ''}`}
        data-testid="wf-pack-model-label"
        data-warn={actual.warn ? 'true' : 'false'}
      >
        {actual.text}
      </p>
      {options.length === 0 && (
        <p className="wf-hint wf-hint-warn">
          还没有文本模型 —— 去「AI 配置」加一个（glm-4.7-flash 免费）
        </p>
      )}

      <button
        type="button"
        className="nodrag wf-link-button"
        onClick={(event) => {
          event.stopPropagation();
          openInspector(id);
        }}
      >
        查看提示词
      </button>
      {data.customPromptId && (
        <span className="wf-node-badge wf-node-badge-custom" data-testid="wf-node-custom-badge">
          自定义
        </span>
      )}
      <p className="wf-hint">输入 = 上游文本；输出 = 包的结构化产物（单次，无追问）</p>
    </NodeShell>
  );
}

interface MediaNodeFieldsProps {
  id: string;
  data: FlowNode['data'];
  kind: 'image' | 'video';
}

function MediaNodeFields({ id, data, kind }: MediaNodeFieldsProps) {
  const options = useWorkflowStore((state) => state.models[kind]);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fromUpstream = data.promptFromUpstream !== false;

  return (
    <>
      <label className="wf-field">
        <span>模型</span>
        <select
          className="nodrag wf-select"
          value={data.modelId ?? ''}
          onChange={(event) => {
            const modelId = event.target.value;
            const picked = options.find((option) => option.modelId === modelId);
            updateNodeData(id, { modelId, vendorId: picked?.providerId });
          }}
        >
          <option value="">（未选模型）</option>
          {options.map((option) => (
            <option key={option.key} value={option.modelId}>
              {option.label}
              {option.free ? '（免费）' : ''}
            </option>
          ))}
        </select>
      </label>
      {options.length === 0 && (
        <p className="wf-hint wf-hint-warn">
          还没有{kind === 'image' ? '生图' : '视频'}模型 —— 去「AI 配置」加一个
          {kind === 'image' ? '（cogview-3-flash 免费）' : '（cogvideox-flash 免费）'}
        </p>
      )}
      <label className="wf-check">
        <input
          className="nodrag"
          type="checkbox"
          checked={fromUpstream}
          onChange={(event) => updateNodeData(id, { promptFromUpstream: event.target.checked })}
        />
        <span>用上游文本当提示词</span>
      </label>
      {!fromUpstream && (
        <textarea
          className="nodrag wf-textarea"
          rows={3}
          placeholder="这个节点的提示词"
          value={data.text ?? ''}
          onChange={(event) => updateNodeData(id, { text: event.target.value })}
        />
      )}
    </>
  );
}

export function ImageNode({ id, data }: NodeProps<FlowNode>) {
  const ports = NODE_PORTS.image;
  return (
    <NodeShell id={id} type="image" data={data} inputs={ports.inputs} outputs={ports.outputs}>
      <MediaNodeFields id={id} data={data} kind="image" />
      <p className="wf-hint">
        固定 1 张：一个节点 = 一次生成。参考图口目前会被忽略（三家官方生图接口都没有这个字段）。
      </p>
    </NodeShell>
  );
}

export function VideoNode({ id, data }: NodeProps<FlowNode>) {
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const ports = NODE_PORTS.video;

  return (
    <NodeShell id={id} type="video" data={data} inputs={ports.inputs} outputs={ports.outputs}>
      <MediaNodeFields id={id} data={data} kind="video" />
      <div className="wf-row">
        <label className="wf-field">
          <span>分辨率</span>
          <select
            className="nodrag wf-select"
            value={data.resolution ?? '480p'}
            onChange={(event) =>
              updateNodeData(id, {
                resolution: event.target.value as '480p' | '720p' | '1080p',
              })
            }
          >
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
        </label>
        <label className="wf-field">
          <span>时长（秒）</span>
          <input
            className="nodrag wf-input"
            type="number"
            min={4}
            max={30}
            value={data.durationSec ?? 5}
            onChange={(event) => {
              const value = Number(event.target.value);
              updateNodeData(id, {
                durationSec: Number.isFinite(value) ? Math.min(30, Math.max(4, value)) : 5,
              });
            }}
          />
        </label>
      </div>
      <p className="wf-hint">
        首帧图口：接「生图 / 图片源」的输出。参考视频口：只支持方舟 Seedance（智谱 CogVideoX 不支持、
        会显式报错），且只认公网 URL。
      </p>
    </NodeShell>
  );
}

interface SourceNodeFieldsProps {
  id: string;
  data: FlowNode['data'];
  kind: SourceKind;
}

/**
 * 「图片源 / 视频源」的共同字段（M5b4 §4.1）：
 * ① 从已有产物里选；② 上传本地文件。两条路都只把**引用**写进节点 data。
 */
function SourceNodeFields({ id, data, kind }: SourceNodeFieldsProps) {
  const options = useWorkflowStore((state) => state.sources[kind]);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [busy, setBusy] = useState(false);
  const label = kind === 'image' ? '图片' : '视频';

  const selectedKey = data.sourceArtifactId
    ? `artifact:${data.sourceArtifactId}`
    : data.sourceMediaId
      ? `media:${data.sourceMediaId}`
      : '';
  const selected = options.find((option) => option.key === selectedKey);

  const refreshSources = async () => {
    const [images, videos] = await Promise.all([
      listSourceOptions('image'),
      listSourceOptions('video'),
    ]);
    useWorkflowStore.getState().setSources({ image: images, video: videos });
  };

  const onPick = (event: ChangeEvent<HTMLSelectElement>) => {
    const key = event.target.value;
    if (key === '') {
      updateNodeData(id, {
        sourceArtifactId: undefined,
        sourceMediaId: undefined,
        fileName: undefined,
        fileSize: undefined,
        error: undefined,
      });
      return;
    }
    const option = options.find((item) => item.key === key);
    if (!option) return;
    updateNodeData(id, {
      sourceArtifactId: option.ref.sourceArtifactId,
      sourceMediaId: option.ref.sourceMediaId,
      fileName: option.label,
      fileSize: option.size,
      error: undefined,
    });
  };

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // 同一个文件连选两次也要能触发
    if (!file) return;

    // 任务书 §4.1：超限**提前拒绝**（别等 IndexedDB 报错）
    const problem = checkSourceFile(kind, file);
    if (problem !== null) {
      updateNodeData(id, { error: problem });
      return;
    }

    setBusy(true);
    try {
      const stored = await storeSourceFile(kind, file);
      updateNodeData(id, {
        sourceMediaId: stored.sourceMediaId,
        sourceArtifactId: undefined,
        fileName: stored.fileName,
        fileSize: stored.fileSize,
        error: undefined,
      });
      await refreshSources();
    } catch (caught) {
      updateNodeData(id, {
        error: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  };

  const previewUrl = selected?.url ?? data.mediaUrl ?? '';

  return (
    <>
      <label className="wf-field">
        <span>已有{label}</span>
        <select
          className="nodrag wf-select"
          data-testid="wf-source-select"
          value={selectedKey}
          onChange={onPick}
        >
          <option value="">（选一个已有产物）</option>
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}（{formatSize(option.size)}）
            </option>
          ))}
        </select>
      </label>
      {options.length === 0 && (
        <p className="wf-hint">
          还没有{label}产物 —— 先在画板或创作页生成一个，或者直接在下面上传本地文件。
        </p>
      )}

      <label className="wf-field">
        <span>或上传{label}（≤ {kind === 'image' ? '10MB' : '100MB'}）</span>
        <input
          className="nodrag wf-input"
          data-testid="wf-source-upload"
          type="file"
          accept={`${kind}/*`}
          disabled={busy}
          onChange={(event) => void onUpload(event)}
        />
      </label>

      {previewUrl !== '' && kind === 'image' && (
        <img className="wf-node-thumb" src={previewUrl} alt={`选中的${label}`} />
      )}
      {previewUrl !== '' && kind === 'video' && (
        <video className="wf-node-thumb" src={previewUrl} controls muted preload="metadata" />
      )}
      {(data.fileName || data.fileSize !== undefined) && (
        <p className="wf-node-meta" data-testid="wf-source-meta">
          {data.fileName ?? '（未命名）'}
          {data.fileSize !== undefined ? ` · ${formatSize(data.fileSize)}` : ''}
        </p>
      )}
      {!data.fileName && selectedKey !== '' && (
        <p className="wf-node-meta">已选：{selectedKey}</p>
      )}
    </>
  );
}

export function ImageSourceNode({ id, data }: NodeProps<FlowNode>) {
  const ports = NODE_PORTS.imageSource;
  return (
    <NodeShell id={id} type="imageSource" data={data} outputs={ports.outputs}>
      <SourceNodeFields id={id} data={data} kind="image" />
      <p className="wf-hint">输出「图片」口：可以接生视频的首帧图，或直接接到输出节点。</p>
    </NodeShell>
  );
}

export function VideoSourceNode({ id, data }: NodeProps<FlowNode>) {
  const ports = NODE_PORTS.videoSource;
  return (
    <NodeShell id={id} type="videoSource" data={data} outputs={ports.outputs}>
      <SourceNodeFields id={id} data={data} kind="video" />
      <p className="wf-hint">
        输出「视频」口：只能接生视频的「参考视频」口（方舟 Seedance 支持；智谱不支持会报错）。
      </p>
    </NodeShell>
  );
}

export function OutputNode({ id, data }: NodeProps<FlowNode>) {
  const onDownloadText = () => {
    const text = data.resultText ?? '';
    if (text === '') return;
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'workflow-output.txt');
  };
  const ports = NODE_PORTS.output;

  return (
    <NodeShell id={id} type="output" data={data} inputs={ports.inputs} showOutput={false}>
      {data.mediaUrl && data.mediaKind === 'image' && (
        <img className="wf-preview wf-preview-image" src={data.mediaUrl} alt="工作流产物" />
      )}
      {data.mediaUrl && data.mediaKind === 'video' && (
        <video className="wf-preview wf-preview-video" src={data.mediaUrl} controls />
      )}
      {data.resultText && <pre className="wf-output-text">{data.resultText}</pre>}
      {!data.resultText && !data.mediaUrl && (
        <p className="wf-hint">运行后在这里预览（文本口 + 图片口 + 视频口，可同时接）</p>
      )}
      {data.resultText && (
        <button type="button" className="nodrag wf-link-button" onClick={onDownloadText}>
          下载文本
        </button>
      )}
      {data.mediaUrl && (
        <a className="nodrag wf-link-button" href={data.mediaUrl} download>
          下载{data.mediaKind === 'image' ? '图片' : '视频'}
        </a>
      )}
    </NodeShell>
  );
}

/** 端口类型 → 中文名（测试与调试用；界面上的标签直接来自端口表） */
export const PORT_LABELS = PORT_TYPE_LABELS;

export const workflowNodeTypes = {
  source: SourceNode,
  merge: MergeNode,
  pack: PackNode,
  image: ImageNode,
  video: VideoNode,
  imageSource: ImageSourceNode,
  videoSource: VideoSourceNode,
  output: OutputNode,
};
