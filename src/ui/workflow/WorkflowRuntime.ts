/**
 * 执行器的"真实现"装配层：把节点接到既有导出上。
 *
 * 纪律（任务书 §0）：**不复制实现，只做装配**
 * - 跑 pack → `src/ui/create/pack-runner.ts`（浏览器版 runPack，M5a3 已有）
 * - 生图   → `adapters/image` 的 `adapterForModel` + `downloadAndStore`
 * - 生视频 → `adapters/video` 的 `adapterForModel` + `VideoTaskRunner`
 * - 记账   → `core/artifacts` 的 `saveArtifact` + `ai-models/config-store` 的 `recordSpend`
 *
 * 超时全部**有上限**（任务书 §6 的血的教训）：文本 60 秒、生图 180 秒、视频轮询 15 分钟。
 * 超时是一条失败，不是"继续等"。
 */

import { activeConnectionFor } from '../../adapters/ai-models/catalog';
import type { AICatalog } from '../../adapters/ai-models/catalog';
import { chat } from '../../adapters/ai-models/client';
import { recordSpend } from '../../adapters/ai-models/config-store';
import type { PriceTable } from '../../adapters/ai-models/pricing';
import { AbstractImageAdapter } from '../../adapters/image/base-adapter';
import { adapterForModel as imageAdapterForModel } from '../../adapters/image/channels';
import { getStoredImage, imageBlobId } from '../../adapters/image/storage';
import type { ImageAspect } from '../../adapters/image/types';
import {
  adapterForModel as videoAdapterForModel,
  coerceResolution,
} from '../../adapters/video/channels';
import { isPublicHttpUrl } from '../../adapters/video/media';
import { VideoTaskRunner } from '../../adapters/video/task-runner';
import type { VideoGenerationRequest, VideoResolution } from '../../adapters/video/types';
import { saveArtifact } from '../../core/artifacts';
import { getRecordEntity } from '../../core/records';
import type { Issue } from '../../packs/validate';
import type { ExecuteDeps, MediaRef, NodeOutput } from './executor';
import { quoteForNode } from './cost';
import { resolveTextModel } from './models';
import { packTextFromOutput, runPackNode } from './packs';
import { resolveSourceMedia } from './sources';
import type { ExecNode, PackId } from './types';
import { isPackId } from './types';

/** 文本生成硬超时（任务书要求 60 秒） */
export const TEXT_TIMEOUT_MS = 60_000;
/** 生图：一次 HTTP（含下载），给足 3 分钟但仍是有限值 */
export const IMAGE_TIMEOUT_MS = 180_000;
/** 视频：整段轮询的硬上限（不是单次请求） */
export const VIDEO_POLL_TIMEOUT_MS = 15 * 60_000;

export interface WorkflowRuntimeOptions {
  catalog: AICatalog;
  priceTable: PriceTable;
  workflowId: string;
  /** 产物归属：source 节点绑定的记录；没有就落到 `workflow:<id>`（不进任何记录的详情页） */
  recordId?: string;
  now?: () => number;
  multiplier?: number;
  /* ---- 测试注入（不传 = 用真实现） ---- */
  chatImpl?: typeof chat;
  imageAdapterFor?: typeof imageAdapterForModel;
  videoAdapterFor?: typeof videoAdapterForModel;
}

/** 装配后的处理器：这三个是 UI 一定会用到的，所以声明成**必填**（可选只在 ExecuteDeps 里） */
export interface NodeHandlers {
  readRecordText: NonNullable<ExecuteDeps['readRecordText']>;
  runPack: ExecuteDeps['runPack'];
  runImage: ExecuteDeps['runImage'];
  runVideo: ExecuteDeps['runVideo'];
  readSource: NonNullable<ExecuteDeps['readSource']>;
  referenceVideoSupported: NonNullable<ExecuteDeps['referenceVideoSupported']>;
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function createNodeHandlers(options: WorkflowRuntimeOptions): NodeHandlers {
  const now = options.now ?? Date.now;
  const chatImpl = options.chatImpl ?? chat;
  const imageAdapterFor = options.imageAdapterFor ?? imageAdapterForModel;
  const videoAdapterFor = options.videoAdapterFor ?? videoAdapterForModel;
  const artifactRecordId = options.recordId ?? `workflow:${options.workflowId}`;

  const readRecordText = async (recordId: string): Promise<string> => {
    const entity = await getRecordEntity(recordId);
    return entity?.text ?? '';
  };

  const runPack = async (
    node: ExecNode,
    text: string,
  ): Promise<{ text: string; issues?: Issue[] }> => {
    const packId: PackId = isPackId(node.data.packId) ? node.data.packId : 'dream-interpretation';
    /**
     * M5b4 §2：**用户在这个节点上选了哪个模型就跑哪个**。
     * 解析失败（没配、或选了配置里已经没有的模型）→ `resolveTextModel` 抛一句能照着做的错，
     * 绝不静默回落到默认模型（那样用户会"以为用了 A，其实用了 B"）。
     */
    const picked = resolveTextModel(options.catalog, {
      providerId: node.data.providerId,
      modelId: node.data.modelId,
    });
    const { model, connection } = picked;

    const result = await runPackNode(packId, text, async (prompt) => {
      const response = await chatImpl(
        {
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          model: model.modelId,
          protocol: connection.protocol,
          timeoutMs: TEXT_TIMEOUT_MS,
        },
        {
          model: model.modelId,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          max_tokens: 2000,
        },
      );
      if (!response.success) throw new Error(response.error.userMessage);
      return response.content;
    });

    return { text: packTextFromOutput(packId, result.output), issues: result.issues };
  };

  const runImage = async (
    node: ExecNode,
    prompt: string,
    _reference?: MediaRef,
  ): Promise<NodeOutput> => {
    const modelId = (node.data.modelId ?? '').trim();
    if (modelId === '') throw new Error('这个生图节点还没选模型');
    const connection = activeConnectionFor(options.catalog, node.data.vendorId ?? '');
    const wiring = imageAdapterFor({
      modelId,
      baseUrl: connection?.baseUrl ?? '',
      apiKey: connection?.apiKey ?? '',
    });
    if (!wiring.ok) throw new Error(`${wiring.reason}${wiring.hint}`);

    const aspect: ImageAspect = '1:1';
    const result = await wiring.adapter.generate({ prompt, model: modelId, count: 1, aspect });
    const image = result.images[0];
    if (!image) throw new Error('生图接口返回了，但一张图都没有');

    const stamp = now();
    const key = `wf_${stamp}`;
    let blobUrl = '';
    let remoteUrl = '';

    if (image.url) {
      remoteUrl = image.url;
      blobUrl = await wiring.adapter.downloadAndStore(image.url, key);
    } else if (image.b64) {
      if (!(wiring.adapter instanceof AbstractImageAdapter)) {
        throw new Error('适配器只回了 base64，但它的实现不支持落盘');
      }
      blobUrl = await wiring.adapter.storeBase64(image.b64, key);
    } else {
      throw new Error('生图接口既没给 url 也没给 base64');
    }

    const stored = await getStoredImage(imageBlobId(key));
    const perImage = wiring.priceRow?.perImage ?? 0;
    const artifact = await saveArtifact({
      id: key,
      recordId: artifactRecordId,
      kind: 'image',
      modelId,
      cost: perImage,
      now: () => stamp,
      payload: {
        prompt,
        remoteUrl,
        blobId: imageBlobId(key),
        mimeType: stored?.mimeType ?? 'image/png',
        size: stored?.blob.size ?? 0,
        expiresAt: stamp + wiring.adapter.urlTtl.ms,
        ttlVerified: wiring.adapter.urlTtl.verified,
        ttlNote: wiring.adapter.urlTtl.note,
        imageSize: result.size,
        source: 'workflow',
      },
    });
    if (perImage > 0) await recordSpend(perImage);

    return {
      media: {
        kind: 'image',
        url: blobUrl,
        mimeType: stored?.mimeType ?? 'image/png',
        artifactId: artifact.id,
        blobId: imageBlobId(key),
      },
      text: prompt,
    };
  };

  const runVideo = async (
    node: ExecNode,
    prompt: string,
    firstFrame?: MediaRef,
    referenceVideo?: MediaRef,
  ): Promise<NodeOutput> => {
    const modelId = (node.data.modelId ?? '').trim();
    if (modelId === '') throw new Error('这个视频节点还没选模型');
    const connection = activeConnectionFor(options.catalog, node.data.vendorId ?? '');
    const wiring = videoAdapterFor({
      modelId,
      baseUrl: connection?.baseUrl ?? '',
      apiKey: connection?.apiKey ?? '',
    });
    if (!wiring.ok) throw new Error(`${wiring.reason}${wiring.hint}`);

    const requested = (node.data.resolution ?? '480p') as VideoResolution;
    // 通道不支持的分辨率要回落（免费档只出 480p），否则提交时一定被拒
    const resolution = coerceResolution(
      { resolutions: wiring.capabilities.resolutions },
      requested,
    );
    const duration = wiring.capabilities.durations === '5' ? 5 : (node.data.durationSec ?? 5);

    // 首帧图：端口有值就传。本地落盘的图只有 blob: URL，服务端取不到，
    // 所以优先把字节塞进 asset（适配器按体积自己分流 base64 / URL）。
    let keyframes: VideoGenerationRequest['keyframes'];
    if (firstFrame) {
      const stored = firstFrame.blobId ? await getStoredImage(firstFrame.blobId) : undefined;
      const bytes = stored ? new Uint8Array(await stored.blob.arrayBuffer()) : undefined;
      keyframes = [
        {
          position: 'first',
          image_url: firstFrame.url,
          asset: bytes
            ? {
                kind: 'image',
                mimeType: stored?.mimeType ?? firstFrame.mimeType,
                size: bytes.byteLength,
                bytes,
              }
            : undefined,
        },
      ];
    }

    const request: VideoGenerationRequest = {
      prompt,
      keyframes,
      params: { duration, resolution, ratio: '16:9', draft_mode: false },
    };

    /**
     * M5b4 §4.2：参考视频（`references.videos`）。
     *
     * 方舟只接受 **URL / 素材 ID**（`adapters/video/media.ts`：所有视频没有"内联 base64"这一档），
     * 而「视频源」上传的文件只存在浏览器 IndexedDB 里 → 没有公网地址就**如实报错**，
     * 不假装传上去了（用户会看到"生成成功但完全没参考到"这种最难查的假象）。
     */
    if (referenceVideo) {
      const publicUrl = (referenceVideo.publicUrl ?? '').trim();
      if (!isPublicHttpUrl(publicUrl)) {
        throw new Error(
          '参考视频只接受公网 URL（方舟不接受 Base64）：这个素材本地有、远端没有地址。' +
            '请换一个带远端地址的产物，或先把文件上传到可公开访问的位置',
        );
      }
      request.references = { videos: [{ url: publicUrl, role: 'motion' }] };
    }

    const submitted = await wiring.adapter.submit(request);
    const runner = new VideoTaskRunner(wiring.adapter, {
      pollIntervalMs: 5000,
      pollTimeoutMs: VIDEO_POLL_TIMEOUT_MS,
    });
    const final = await runner.waitForTask(submitted.task_id);
    if (final.phase !== 'succeeded' || !final.task.result) {
      throw new Error(final.task.error?.message ?? `视频任务没有成功（${final.phase}）`);
    }

    const localUrl = await wiring.adapter.downloadAndStore(final.task.result.video_url, submitted.task_id);
    const quote = quoteForNode(node, {
      priceTable: options.priceTable,
      multiplier: options.multiplier,
    });
    const cost = quote && !quote.free ? quote.amount : 0;
    if (cost > 0) await recordSpend(cost);

    return {
      media: { kind: 'video', url: localUrl, mimeType: 'video/mp4' },
      text: prompt,
    };
  };

  /**
   * M5b4 §4.2：当前视频模型能不能吃参考视频。
   * 能力来自适配器（`capabilities.supportsReferenceVideo`），**不是**这里按厂商名写死。
   */
  const referenceVideoSupported = (node: ExecNode): string | null => {
    const modelId = (node.data.modelId ?? '').trim();
    if (modelId === '') {
      return '这个「生视频」节点还没选模型：先选一个支持参考视频的模型（例如方舟 Seedance），或移除「参考视频」那条连线';
    }
    const connection = activeConnectionFor(options.catalog, node.data.vendorId ?? '');
    const wiring = videoAdapterFor({
      modelId,
      baseUrl: connection?.baseUrl ?? '',
      apiKey: connection?.apiKey ?? '',
    });
    if (!wiring.ok) return `${wiring.reason}${wiring.hint}`;
    if (wiring.capabilities.supportsReferenceVideo) return null;
    return `当前模型（${modelId}）不支持参考视频：请换方舟 Seedance，或移除「参考视频」那条连线`;
  };

  /** M5b4 §4.1：图片源 / 视频源读素材（artifacts 或 media 里的那一条） */
  const readSource = (node: ExecNode): Promise<MediaRef> => resolveSourceMedia(node);

  return { readRecordText, runPack, runImage, runVideo, readSource, referenceVideoSupported };
}

export { errorText };
