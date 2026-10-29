/**
 * AI Provider 工厂（M3 落地）。
 *
 * 约定不变：UI / core 只通过 createProvider 拿到 AIProvider，不直接 new 具体实现；
 * 这样 M6 裁剪小程序时，删掉整个 adapters/ai-models 目录即可。
 *
 * M3 支持两类协议：
 * - `openai`：`POST {base}/v1/chat/completions`、`GET {base}/v1/models`（无 /v1 的站自动降级）
 * - `anthropic`：`POST {base}/v1/messages`（Claude 官方）
 */
import { chat, listModels } from './client';
import type { ClientDeps } from './client';
import type { AIProvider, ProviderConfig } from './types';

export const SUPPORTED_PROVIDERS: readonly string[] = ['openai', 'openai-compatible', 'anthropic'];

/** 让 UI 能拿到 code 的异常（AIProvider.listModels 契约只允许返回 string[]） */
export class AICallError extends Error {
  readonly code: string;

  readonly userMessage: string;

  constructor(code: string, message: string, userMessage: string) {
    super(message);
    this.name = 'AICallError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

/** 按 providerId 选择协议（M3 只区分 OpenAI 兼容 / Anthropic 两种） */
export function createProvider(config: ProviderConfig, deps: ClientDeps = {}): AIProvider {
  const protocol = config.providerId === 'anthropic' ? 'anthropic' : 'openai';
  const input = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    protocol,
    timeoutMs: config.timeoutMs,
  } as const;

  return {
    providerId: config.providerId,
    chat: (request) => chat(input, request, deps),
    listModels: async () => {
      const result = await listModels(input, deps);
      if (!result.ok) {
        throw new AICallError(
          result.error?.code ?? 'unknown',
          result.error?.message ?? '拉取模型列表失败',
          result.error?.userMessage ?? '拉取模型列表失败，可以手填模型名',
        );
      }
      return result.models;
    },
  };
}
