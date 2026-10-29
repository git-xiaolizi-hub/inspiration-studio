/**
 * 视频生成面板（M4b §4.3 / M4c §4.2）。
 *
 * 四件事必须一起出现，缺一个都不算交付：
 * 1. **提交前预估**：复用 M3 的 `estimateVideo` / `draftLines` / `checkBudget`，样片两行金额；
 * 2. **预算闸门**：超预算时按钮变「仍需生成」，**未确认不发请求**（判据 11）；
 * 3. **真人人脸警告**：Seedance 不支持直接上传含真人人脸的参考图/视频 → 给官方肖像方案链接；
 * 4. **状态机可视化**：排队 / 运行（含 elapsed）/ 成功 / 失败（分类 + 下一步）。
 *
 * M4c 追加（免费通道）：
 * 5. **按通道禁用参数**：`capabilities` 为 false 的项直接 disabled + 说明原因（不让人填了才报错）；
 * 6. **免费通道记账**：预估显示「免费」，成功后 `actualCost = 0` 且**不进累计花费**（判据 19）；
 * 7. **排队可见**：订阅适配器的重试事件，显示「免费模型拥挤，排队重试中（第 n 次）」（判据 14）。
 *
 * 这个组件只依赖 `VideoAdapter` 接口 + 注入的时钟/等待器，不直接碰 fetch，
 * 所以测试里可以完全离线地驱动状态机。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './video.css';
import {
  checkBudget,
  formatYuan,
  OFFICIAL_PRICE_TABLE,
} from '../../adapters/ai-models/pricing';
import type { PriceTable } from '../../adapters/ai-models/pricing';
import { PORTRAIT_ASSET_GUIDE_URL, PRICE_TABLE_MODEL_NAME } from '../../adapters/video/constants';
import { Dialog } from '../components/Dialog';
import { PAID_CHANNEL_CAPABILITIES } from '../../adapters/video/capabilities';
import type { VideoChannelCapabilities } from '../../adapters/video/capabilities';
import { actualCostForChannel } from '../../adapters/video/channels';
import { describeTask, isVideoError } from '../../adapters/video/errors';
import type { TaskFailureView } from '../../adapters/video/errors';
import { estimateVideoRequest } from '../../adapters/video/estimate';
import { artifactNotice, getVideoArtifact } from '../../adapters/video/storage';
import { VideoTaskRunner } from '../../adapters/video/task-runner';
import type { RunnerSnapshot } from '../../adapters/video/task-runner';
import type {
  MediaAsset,
  VideoAdapter,
  VideoGenerationRequest,
  VideoRatio,
  VideoResolution,
  VideoTask,
} from '../../adapters/video/types';

export interface VideoGenerationPanelProps {
  adapter: VideoAdapter & {
    isAborted?: (taskId: string) => boolean;
    /** 免费通道的排队重试事件（Ark 没有，不传即可） */
    listenRetry?: (listener: (info: { attempt: number; delayMs: number }) => void) => () => void;
  };
  /** 当前通道能力；不传 = 付费通道（与 M4b 行为完全一致） */
  capabilities?: VideoChannelCapabilities;
  /** 通道名（显示在标题里）；不传 = 「Ark Seedance 2.5」 */
  channelLabel?: string;
  priceTable?: PriceTable;
  /** 价格表里的模型族名；默认 seedance 2.5 */
  priceModel?: string;
  /** 计费倍率（M3R4 §4.2）：来自 AI 配置里当前连接的「倍率」，默认 1 = 官方价 */
  multiplier?: number;
  /** 已累计花费（元） */
  spent: number;
  budgetLimit: number | null;
  /** 生成成功后回填花费（用接口返回的 usage 反算，或直接用估值）；免费通道不会调用 */
  onSpend?: (amount: number) => void;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 读文件字节（jsdom 缺 Blob.arrayBuffer，测试可注入） */
  readFile?: (file: File) => Promise<Uint8Array>;
  /**
   * 提交前问一句「本次预计花费 ¥x，继续？」（R6）。
   *
   * 为什么是宿主开关而不是面板默认行为：R6 删掉了设置页的「预算限额」卡，
   * 总预算不再拦人，只在**单次生视频**时提醒这一笔。生产路径（创作页 → VideoGenerationSection）
   * 一律传 `true`；直接挂面板的老用例保持「点一次就提交」的原语义。
   */
  askBeforeSubmit?: boolean;
}

type Phase = 'idle' | 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '未开始',
  submitting: '提交中',
  queued: '排队中',
  running: '运行中',
  succeeded: '生成成功',
  failed: '生成失败',
  aborted: '已本地取消',
};

const RATIOS: VideoRatio[] = ['16:9', '9:16', '1:1', 'adaptive'];

export async function defaultReadFile(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  // jsdom / 老浏览器兜底
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

export function VideoGenerationPanel({
  adapter,
  capabilities = PAID_CHANNEL_CAPABILITIES,
  channelLabel,
  priceTable = OFFICIAL_PRICE_TABLE,
  priceModel = PRICE_TABLE_MODEL_NAME,
  multiplier = 1,
  spent,
  budgetLimit,
  onSpend,
  pollIntervalMs,
  pollTimeoutMs,
  now = () => Date.now(),
  sleep,
  readFile = defaultReadFile,
  askBeforeSubmit = false,
}: VideoGenerationPanelProps) {
  const free = capabilities.paid === false;
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState<VideoResolution>(
    capabilities.resolutions.includes('720p') ? '720p' : capabilities.resolutions[0],
  );
  const [ratio, setRatio] = useState<VideoRatio>('adaptive');
  const [draftMode, setDraftMode] = useState(false);
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [firstFrame, setFirstFrame] = useState<File | null>(null);
  const [lastFrame, setLastFrame] = useState<File | null>(null);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState('');
  // 免费通道的首尾帧只能填公网 URL（keyframeSource === 'url'）
  const [firstFrameUrl, setFirstFrameUrl] = useState('');
  const [lastFrameUrl, setLastFrameUrl] = useState('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [snapshot, setSnapshot] = useState<RunnerSnapshot | null>(null);
  const [failure, setFailure] = useState<TaskFailureView | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actual, setActual] = useState<{
    tokens: number;
    cost: number;
    fromUsage: boolean;
    free: boolean;
  } | null>(null);
  const [confirmArmed, setConfirmArmed] = useState(false);
  /** R6：单次花费提醒弹窗开着（点「继续」才真的发请求） */
  const [spendConfirmOpen, setSpendConfirmOpen] = useState(false);
  const [retry, setRetry] = useState<{ attempt: number; delayMs: number } | null>(null);

  const runnerRef = useRef<VideoTaskRunner | null>(null);
  const taskIdRef = useRef<string | null>(null);

  // 换通道后当前分辨率可能不被允许（例如 1080p → 免费通道）：回落而不是让提交时才报错
  useEffect(() => {
    if (!capabilities.resolutions.includes(resolution)) {
      setResolution(capabilities.resolutions[0]);
    }
  }, [capabilities, resolution]);

  // 免费通道固定 5 秒（duration 默认不传，见 zhipu-constants）
  useEffect(() => {
    if (capabilities.durations === '5' && duration !== 5) setDuration(5);
  }, [capabilities, duration]);

  // 免费通道的排队重试事件（Ark 适配器没有 listenRetry，这里自动跳过）
  useEffect(() => {
    if (typeof adapter.listenRetry !== 'function') return undefined;
    // 必须挂回 adapter 上调用：解构出来会丢 this
    return adapter.listenRetry((info) => setRetry({ attempt: info.attempt, delayMs: info.delayMs }));
  }, [adapter]);

  const estimateInput = useMemo(
    () => ({
      request: {
        prompt,
        params: {
          duration: capabilities.durations === '5' ? 5 : duration,
          resolution,
          ratio,
          draft_mode: draftMode,
        },
      } as VideoGenerationRequest,
      priceTable,
      priceModel,
      multiplier,
    }),
    [prompt, duration, resolution, ratio, draftMode, priceTable, priceModel, multiplier, capabilities],
  );

  const built = useMemo(() => estimateVideoRequest(estimateInput), [estimateInput]);
  const verdict = useMemo(
    () => checkBudget({ estimate: built.estimate.total, spent, budget: budgetLimit }),
    [built.estimate.total, spent, budgetLimit],
  );

  // 参数一变，先前"已确认超预算"就作废（避免确认过一次之后随便改参数都放行）
  useEffect(() => {
    setConfirmArmed(false);
  }, [duration, resolution, ratio, draftMode, prompt, referenceVideoUrl]);

  const attached =
    referenceImage !== null ||
    firstFrame !== null ||
    lastFrame !== null ||
    referenceVideoUrl.trim() !== '' ||
    firstFrameUrl.trim() !== '' ||
    lastFrameUrl.trim() !== '';

  const buildRequest = useCallback(async (): Promise<VideoGenerationRequest> => {
    const toAsset = async (file: File, kind: MediaAsset['kind']): Promise<MediaAsset> => ({
      kind,
      mimeType: file.type || (kind === 'image' ? 'image/png' : 'video/mp4'),
      size: file.size,
      bytes: await readFile(file),
      name: file.name,
    });

    const references: VideoGenerationRequest['references'] = {};
    // 不支持的能力即使还留着旧状态也不带上（通道切换的最坏情况）
    if (referenceImage && capabilities.supportsImageReference) {
      references.images = [{ role: 'character', asset: await toAsset(referenceImage, 'image') }];
    }
    if (referenceVideoUrl.trim() && capabilities.supportsReferenceVideo) {
      references.videos = [{ role: 'motion', url: referenceVideoUrl.trim() }];
    }

    const keyframes: NonNullable<VideoGenerationRequest['keyframes']> = [];
    if (capabilities.supportsKeyframes) {
      if (capabilities.keyframeSource === 'url') {
        if (firstFrameUrl.trim()) keyframes.push({ position: 'first', image_url: firstFrameUrl.trim() });
        if (lastFrameUrl.trim()) keyframes.push({ position: 'last', image_url: lastFrameUrl.trim() });
      } else {
        if (firstFrame) keyframes.push({ position: 'first', asset: await toAsset(firstFrame, 'image') });
        if (lastFrame) keyframes.push({ position: 'last', asset: await toAsset(lastFrame, 'image') });
      }
    }

    return {
      prompt,
      references,
      keyframes: keyframes.length > 0 ? keyframes : undefined,
      params: {
        duration: capabilities.durations === '5' ? 5 : duration,
        resolution,
        ratio,
        draft_mode: capabilities.supportsDraftMode ? draftMode : false,
      },
    };
  }, [
    prompt,
    duration,
    resolution,
    ratio,
    draftMode,
    referenceImage,
    firstFrame,
    lastFrame,
    referenceVideoUrl,
    firstFrameUrl,
    lastFrameUrl,
    readFile,
    capabilities,
  ]);

  const runTask = useCallback(
    async (taskId: string) => {
      const runner = new VideoTaskRunner(adapter, {
        pollIntervalMs,
        pollTimeoutMs,
        now,
        sleep,
        onChange: (next) => {
          setSnapshot(next);
          setPhase(next.phase);
        },
      });
      runnerRef.current = runner;
      taskIdRef.current = taskId;
      const final = await runner.waitForTask(taskId);
      setSnapshot(final);
      setPhase(final.phase);

      if (final.phase === 'failed') {
        setFailure(describeTask(final.task));
        return;
      }
      if (final.phase !== 'succeeded' || !final.task.result) return;

      // 用接口返回的 usage 反算真实花费（§13.4 裁决：预算累加不能只用估值）
      const tokens = final.task.result.usage.completion_tokens;
      const officialRate = built.estimate.items[built.estimate.items.length - 1]?.rate ?? null;
      // 反算也要乘倍率，否则中转实付会被少记
      const rate = officialRate === null ? null : officialRate * multiplier;
      const actualCost = actualCostForChannel(capabilities, tokens, rate, built.estimate.total);
      setActual({
        tokens,
        cost: actualCost,
        fromUsage: !free && rate !== null && tokens > 0,
        free,
      });

      try {
        const url = await adapter.downloadAndStore(final.task.result.video_url, taskId);
        setLocalUrl(url);
        const artifact = await getVideoArtifact(taskId);
        setNotice(
          artifact
            ? artifactNotice(artifact, now())
            : '视频已下载到本地库；官方地址 24 小时后失效，请尽快另存',
        );
      } catch (error) {
        setMessage(
          isVideoError(error)
            ? `${error.title}：${error.nextStep}`
            : `下载失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // 判据 19：免费通道不进累计花费（不是记 0，是根本不记账）
      if (!free) onSpend?.(actualCost);
    },
    [adapter, pollIntervalMs, pollTimeoutMs, now, sleep, onSpend, built.estimate.total, built.estimate.items, capabilities, free, multiplier],
  );

  /** 真正发请求的那一半（确认框点「继续」后走这里，不再重复弹窗） */
  const submitNow = useCallback(async () => {
    setPhase('submitting');
    try {
      const request = await buildRequest();
      const { task_id } = await adapter.submit(request);
      setPhase('queued');
      await runTask(task_id);
    } catch (error) {
      setPhase('failed');
      if (isVideoError(error)) {
        setFailure({
          category: error.category,
          title: error.title,
          nextStep: error.nextStep,
          message: error.message,
        });
      } else {
        setFailure({
          category: 'unknown',
          title: '提交失败',
          nextStep: '检查参数与网络后重试',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [buildRequest, adapter, runTask]);

  const handleSubmit = useCallback(async () => {
    setMessage(null);
    setFailure(null);
    setLocalUrl(null);
    setNotice(null);
    setActual(null);
    setSnapshot(null);
    setRetry(null);

    // 预算闸门：超预算必须先确认（判据 11 —— 未确认时一个请求都不发）；免费通道不做闸门
    if (!free && verdict.requiresConfirm && !confirmArmed) {
      setConfirmArmed(true);
      setMessage('这次生成会超出预算：再点一次「确认生成」才会提交');
      return;
    }

    // R6 单次花费提醒：真正发请求前先问一句（免费模型不计费，不弹）
    if (askBeforeSubmit && !free) {
      setSpendConfirmOpen(true);
      return;
    }

    await submitNow();
  }, [verdict.requiresConfirm, confirmArmed, free, askBeforeSubmit, submitNow]);

  const handleCancel = useCallback(async () => {
    const taskId = taskIdRef.current;
    if (!taskId) return;
    await runnerRef.current?.cancel(taskId);
    setPhase('aborted');
    setMessage(`已本地取消：停止轮询，沿用任务 ID ${taskId}（任务可能仍在服务端运行并计费）`);
  }, []);

  const submitLabel =
    !free && verdict.requiresConfirm && !confirmArmed
      ? '超出预算 · 仍需生成'
      : !free && confirmArmed && verdict.requiresConfirm
        ? '确认生成（已超预算）'
        : '生成视频';

  const title = channelLabel ?? 'Ark Seedance 2.5';

  return (
    <section className="card">
      <h3>视频生成（{title}）</h3>

      {free ? (
        <p className="warn-inline" role="note" data-testid="free-model-notice">
          免费模型：不计费，但可能排队 429，画质有限
        </p>
      ) : (
        <p className="warn-inline" role="note">
          不支持含真人人脸的参考图 / 参考视频：请改用官方预置虚拟人像或已授权真人素材（
          <a href={PORTRAIT_ASSET_GUIDE_URL} target="_blank" rel="noreferrer">
            官方肖像素材方案
          </a>
          ）。上传前请先确认这一点。
        </p>
      )}

      <div className="stt-form">
        <label className="field">
          <span>提示词</span>
          <textarea
            aria-label="视频提示词"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder={free ? '画面描述、运镜、光线…（免费模型必填）' : '画面描述、运镜、光线…（可留空，只用素材）'}
          />
        </label>

        <label className="field">
          <span>
            {free ? '时长（固定 5 秒 · 免费模型口径）' : '时长（秒，4–30；-1 = 模型自选）'}
          </span>
          <input
            aria-label="时长（秒）"
            type="number"
            value={capabilities.durations === '5' ? 5 : duration}
            min={capabilities.durations === '5' ? 5 : -1}
            max={capabilities.durations === '5' ? 5 : 30}
            disabled={capabilities.durations === '5'}
            onChange={(event) => setDuration(Number(event.target.value))}
          />
        </label>

        <label className="field">
          <span>分辨率</span>
          <select
            aria-label="分辨率"
            value={resolution}
            onChange={(event) => setResolution(event.target.value as VideoResolution)}
          >
            {capabilities.resolutions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>画面比例</span>
          <select aria-label="比例" value={ratio} onChange={(event) => setRatio(event.target.value as VideoRatio)}>
            {RATIOS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>
            样片模式（Draft，先 480p 再出成片）
            {!capabilities.supportsDraftMode ? ' · 当前模型不支持' : ''}
          </span>
          <input
            aria-label="样片模式"
            type="checkbox"
            checked={capabilities.supportsDraftMode ? draftMode : false}
            disabled={!capabilities.supportsDraftMode}
            onChange={(event) => setDraftMode(event.target.checked)}
          />
        </label>

        <label className="field">
          <span>
            参考图（&lt; 5MB 自动转 Base64）
            {!capabilities.supportsImageReference ? ' · 当前模型不支持参考图角色' : ''}
          </span>
          <input
            aria-label="参考图"
            type="file"
            accept="image/*"
            disabled={!capabilities.supportsImageReference}
            onChange={(event) => setReferenceImage(event.target.files?.[0] ?? null)}
          />
        </label>

        <label className="field">
          <span>
            首帧{capabilities.keyframeSource === 'url' ? '（公网 URL）' : capabilities.supportsKeyframes ? '' : ' · 当前模型不支持'}
          </span>
          {capabilities.keyframeSource === 'url' ? (
            <input
              aria-label="首帧"
              type="text"
              value={firstFrameUrl}
              disabled={!capabilities.supportsKeyframes}
              onChange={(event) => setFirstFrameUrl(event.target.value)}
              placeholder="https://…/first.png（免费模型只收公网图片地址）"
            />
          ) : (
            <input
              aria-label="首帧"
              type="file"
              accept="image/*"
              disabled={!capabilities.supportsKeyframes}
              onChange={(event) => setFirstFrame(event.target.files?.[0] ?? null)}
            />
          )}
        </label>

        <label className="field">
          <span>
            尾帧{capabilities.keyframeSource === 'url' ? '（公网 URL，可选）' : capabilities.supportsKeyframes ? '' : ' · 当前模型不支持'}
          </span>
          {capabilities.keyframeSource === 'url' ? (
            <input
              aria-label="尾帧"
              type="text"
              value={lastFrameUrl}
              disabled={!capabilities.supportsKeyframes}
              onChange={(event) => setLastFrameUrl(event.target.value)}
              placeholder="https://…/last.png（留空则只用首帧）"
            />
          ) : (
            <input
              aria-label="尾帧"
              type="file"
              accept="image/*"
              disabled={!capabilities.supportsKeyframes}
              onChange={(event) => setLastFrame(event.target.files?.[0] ?? null)}
            />
          )}
        </label>

        <label className="field">
          <span>
            参考视频公网 URL（视频不支持 Base64）
            {!capabilities.supportsReferenceVideo ? ' · 当前模型不支持视频参考' : ''}
          </span>
          <input
            aria-label="参考视频 URL"
            type="text"
            value={referenceVideoUrl}
            disabled={!capabilities.supportsReferenceVideo}
            onChange={(event) => setReferenceVideoUrl(event.target.value)}
            placeholder={capabilities.supportsReferenceVideo ? 'https://…/clip.mp4' : '免费模型不支持视频参考'}
          />
        </label>
      </div>

      {free && (
        <p className="muted small">
          已禁用：样片模式（Draft 只有 Seedance 有）、参考视频、参考图角色。要这些能力请换到 Seedance 2.5。
        </p>
      )}

      {attached && (
        <p className="warn-inline">
          已附加参考素材：请确认素材里没有真人人脸（含真人照片、截图、AI 生成的真实人脸都可能被拦）。
        </p>
      )}

      <div className="estimate-list">
        {free ? (
          <>
            <p data-estimate="free">预计花费 免费（免费模型不计费，累计花费不变）</p>
            <p className="muted small">
              免费模型限制：480p / 720p、固定 5 秒、无声、无样片；视频上的水印由服务方决定。
            </p>
          </>
        ) : (
          <>
            <p>
              {built.estimate.error ? `预估失败：${built.estimate.error}` : '费用明细'}
            </p>
            {built.lines && (
              <p className="estimate-draft">
                ① {built.lines.draft} ② {built.lines.final}
              </p>
            )}
            {built.advice && <p className="muted small">{built.advice}</p>}
            <p className="muted small">{verdict.summary}</p>
            {verdict.message && <p className="warn-inline">{verdict.message}</p>}
            {built.notices.map((text) => (
              <p className="muted small" key={text}>
                {text}
              </p>
            ))}
            <p className="muted small">
              价格来源：{built.estimate.priceSource}（{built.estimate.verifiedAt}
              {built.estimate.verified ? '' : '，未验证'}）
            </p>
          </>
        )}
      </div>

      {/* R6：按钮上方一行小字，先说清这一笔大概多少钱 */}
      {!free && (
        <p className="estimate-inline" data-testid="estimate-inline">
          {built.estimate.error
            ? '费用未知'
            : `本次约 ${formatYuan(built.estimate.total)}`}
          {` · ${built.estimate.outSec}s ${built.estimate.res}`}
          {draftMode ? '（含样片两步）' : ''}
        </p>
      )}

      <div className="button-row">
        <button
          className="button"
          onClick={() => void handleSubmit()}
          disabled={phase === 'submitting' || phase === 'queued' || phase === 'running'}
        >
          {submitLabel}
        </button>
        <button
          className="button"
          onClick={() => void handleCancel()}
          disabled={!snapshot || phase === 'succeeded' || phase === 'failed' || phase === 'aborted'}
        >
          取消（本地）
        </button>
      </div>

      <div className="video-status" role="status">
        <ol className="video-phases">
          {(['queued', 'running', 'succeeded', 'failed', 'aborted'] as Phase[]).map((item) => (
            <li key={item} data-active={phase === item}>
              {PHASE_LABEL[item]}
            </li>
          ))}
        </ol>
        <p data-phase={phase}>
          状态：{PHASE_LABEL[phase]}
          {snapshot && (phase === 'queued' || phase === 'running' || phase === 'succeeded' || phase === 'aborted')
            ? ` · 已过 ${formatElapsed(snapshot.elapsedMs)} · 轮询 ${snapshot.polls} 次`
            : ''}
        </p>
        {retry && (
          <p className="warn-inline" data-retry={retry.attempt}>
            免费模型拥挤，排队重试中（第 {retry.attempt} 次，{Math.round(retry.delayMs / 1000)} 秒后重试）
          </p>
        )}
        {snapshot && snapshot.task.raw_status && (
          <p className="muted small">服务端原始状态：{snapshot.task.raw_status}</p>
        )}
        {taskIdRef.current && <p className="muted small">任务 ID：{taskIdRef.current}</p>}
        {message && <p className="muted small">{message}</p>}
        {actual && (
          <p className="muted small">
            {actual.free
              ? '免费模型：本次不计费（累计花费不变）'
              : actual.fromUsage
                ? `实际用量 ${actual.tokens.toLocaleString()} token → ${formatYuan(actual.cost)}（已按接口 usage 计入累计花费）`
                : `接口未返回用量，先按预估 ${formatYuan(actual.cost)} 计入累计花费`}
          </p>
        )}
      </div>

      {failure && (
        <div className="error" role="alert">
          <p>
            {failure.title}
            {failure.code ? `（${failure.code}）` : ''}
          </p>
          <p className="muted small">{failure.message}</p>
          <p>下一步：{failure.nextStep}</p>
        </div>
      )}

      {localUrl && (
        <div className="success">
          <p>{notice}</p>
          <video src={localUrl} controls width={480} />
        </div>
      )}

      {/* R6 单次花费提醒：点「生成视频」先拦一下，未确认不发请求 */}
      <Dialog
        open={spendConfirmOpen}
        title="确认本次花费？"
        label="生视频花费确认"
        onDismiss={() => setSpendConfirmOpen(false)}
        actions={[
          { label: '取消', onClick: () => setSpendConfirmOpen(false), testId: 'video-spend-cancel' },
          {
            label: '继续',
            kind: 'primary',
            testId: 'video-spend-continue',
            onClick: () => {
              setSpendConfirmOpen(false);
              void submitNow();
            },
          },
        ]}
      >
        <p className="modal-sub">
          {built.estimate.error
            ? '这个模型没有价格表，可能产生费用。'
            : `本次生成预计花费 ${formatYuan(built.estimate.total)}，继续？`}
        </p>
        <p className="modal-sub">
          {built.estimate.outSec}s · {built.estimate.res}
          {draftMode ? ' · 含样片两步' : ''} · 价格来自价格表估算，实际以账单为准
        </p>
      </Dialog>
    </section>
  );
}

export type { VideoTask };
