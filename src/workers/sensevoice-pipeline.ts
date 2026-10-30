/**
 * 本地转写：SenseVoice-Small（onnxruntime-web）。
 *
 * 模型从哪来：
 *   1. Cache Storage（用户点过「下载」→ 见 adapters/asr/model-store.ts）；
 *   2. 站点静态目录 `public/models/<id>/`（桌面版内置 / 开发机）。
 * 都没有就抛 MODEL_MISSING，由 UI 引导去下载。
 */
import { ORT_ASSETS } from '../adapters/asr/sensevoice/ort-assets';
import { createSession, type SenseVoiceSession } from '../adapters/asr/sensevoice/recognizer';
import { MODEL_CACHE_NAME, findPack, modelFileKey, modelsDirUrl } from '../adapters/asr/model-spec';
import type { Transcriber, TranscriberFactory } from './asr-worker-core';

interface ModelFiles {
  model: ArrayBuffer;
  tokens: string;
}

async function fetchStatic(id: string, file: string): Promise<Response | null> {
  try {
    const response = await fetch(new URL(`${id}/${file}`, modelsDirUrl()));
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

async function loadModelFiles(modelId: string): Promise<ModelFiles> {
  const pack = findPack(modelId as never);
  if (!pack) throw new Error(`未知的本地模型：${modelId}（找不到对应的模型包）`);

  // ① 浏览器缓存
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const model = await cache.match(modelFileKey(pack.id, pack.modelFile));
      const tokens = await cache.match(modelFileKey(pack.id, pack.tokensFile));
      if (model && tokens) {
        return { model: await model.arrayBuffer(), tokens: await tokens.text() };
      }
    } catch {
      // 缓存不可用（隐私模式等）→ 退回静态目录
    }
  }

  // ② 静态目录
  const [modelResponse, tokensResponse] = await Promise.all([
    fetchStatic(pack.id, pack.modelFile),
    fetchStatic(pack.id, pack.tokensFile),
  ]);
  if (!modelResponse || !tokensResponse) {
    throw new Error('模型还没下载');
  }
  return { model: await modelResponse.arrayBuffer(), tokens: await tokensResponse.text() };
}

let cached: { modelId: string; session: SenseVoiceSession } | null = null;

export const createLocalTranscriber: TranscriberFactory = async ({ modelId, onProgress }) => {
  onProgress({ stage: 'loading-model', pct: 5 });

  if (!cached || cached.modelId !== modelId) {
    const { model, tokens } = await loadModelFiles(modelId);
    onProgress({ stage: 'loading-model', pct: 45 });
    const session = await createSession(model, tokens, ORT_ASSETS);
    cached = { modelId, session };
  }
  onProgress({ stage: 'loading-model', pct: 100 });

  const transcriber: Transcriber = async (audio, options) => {
    onProgress({ stage: 'transcribing', pct: 0 });
    const text = await cached!.session.transcribe(audio, {
      language: options?.language === 'english' ? 'en' : 'zh',
    });
    onProgress({ stage: 'transcribing', pct: 100 });
    return { text };
  };
  return transcriber;
};

/** 测试用 */
export function resetLocalPipelineCache(): void {
  cached = null;
}
