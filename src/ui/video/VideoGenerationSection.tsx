/**
 * 「生视频」这一块，从原视频页里原样搬过来（P2 任务 B）。
 *
 * 为什么不是直接保留 `VideoPage`：`/video` 独立页被委托方判为冗余（「视频页是冗余，
 * 应该加入单卡创作」），它的能力要**落进单卡创作的生视频 tab**。所以把页面正文
 * 抽成这个 section，页面壳（标题 + 说明 + `<div class="page">`）随页面一起删掉。
 *
 * 这里自己负责两件事（与原页面一致，没有行为变化）：
 * 1. **模型下拉**：内容 = 模型表里 `caps` 含 `video` 的模型（`listModelsByCap` 的同一份数据）；
 *    选中哪个模型，就按它的能力位渲染参数（面板负责禁用不支持的项）；
 * 2. **装配**：`adapterForModel(model)` 决定用哪个适配器、什么能力、按哪张价格表预估。
 *
 * 宿主可以注入 catalog / priceTable / spent / budgetLimit（单卡创作页就是这么用的，
 * 它自己已经读过配置，不必让这一块再读一遍 IndexedDB）；不传才回落到本机配置。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import './video.css';
import { activeConnectionFor, listModelsByCap, loadCatalog, multiplierOf } from '../../adapters/ai-models/catalog';
import type { AICatalog, VideoModelRef } from '../../adapters/ai-models/catalog';
import { loadAIConfig, loadPriceTable, loadSpend, recordSpend } from '../../adapters/ai-models/config-store';
import { OFFICIAL_PRICE_TABLE } from '../../adapters/ai-models/pricing';
import type { PriceTable } from '../../adapters/ai-models/pricing';
import { adapterForModel } from '../../adapters/video/channels';
import type { ChannelAdapter } from '../../adapters/video/channels';
import { VideoGenerationPanel } from './VideoGenerationPanel';

/** 模型表里一个视频模型都没有时的可执行提示（§3.4） */
export const VIDEO_MODEL_EMPTY_HINT =
  '你还没有配置视频模型 —— 去 AI 配置点 doubao-seedance-2-5-260628（视频，推荐）或 cogvideox-flash（视频，免费测试）';

const EMPTY_CATALOG: AICatalog = { providers: [], updatedAt: 0 };

export interface VideoGenerationSectionProps {
  /** 注入已构造的适配器（测试 / 宿主托管生命周期时用） */
  arkAdapter?: ChannelAdapter;
  zhipuAdapter?: ChannelAdapter;
  /** 注入模型表；不传 = 从本机 IndexedDB 读 */
  catalog?: AICatalog;
  spent?: number;
  budgetLimit?: number | null;
  priceTable?: PriceTable;
  onSpend?: (amount: number) => void;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (file: File) => Promise<Uint8Array>;
}

interface LoadedState {
  catalog: AICatalog;
  budgetLimit: number | null;
  spent: number;
  priceTable: PriceTable;
}

function modelKey(model: Pick<VideoModelRef, 'providerId' | 'modelId'>): string {
  return `${model.providerId}::${model.modelId}`;
}

export function VideoGenerationSection({
  arkAdapter,
  zhipuAdapter,
  catalog: catalogProp,
  spent,
  budgetLimit,
  priceTable,
  onSpend,
  pollIntervalMs,
  pollTimeoutMs,
  now,
  sleep,
  readFile,
}: VideoGenerationSectionProps) {
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [spentValue, setSpentValue] = useState<number>(spent ?? 0);
  const [selectedKey, setSelectedKey] = useState<string>('');

  // 读本地配置：只读"没被 props 注入"的那几项，测试因此可以完全离线
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [catalogFromStore, aiConfig, spendState, table] = await Promise.all([
        catalogProp === undefined ? loadCatalog() : Promise.resolve(null),
        budgetLimit === undefined ? loadAIConfig() : Promise.resolve(null),
        spent === undefined ? loadSpend() : Promise.resolve(null),
        priceTable === undefined ? loadPriceTable() : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setLoaded({
        catalog: catalogProp ?? catalogFromStore ?? EMPTY_CATALOG,
        budgetLimit: budgetLimit !== undefined ? budgetLimit : aiConfig?.budgetLimit ?? null,
        spent: spent ?? spendState?.spent ?? 0,
        priceTable: priceTable ?? table ?? OFFICIAL_PRICE_TABLE,
      });
      if (spent !== undefined) setSpentValue(spent);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [catalogProp, spent, budgetLimit, priceTable]);

  const models = useMemo(
    () => (loaded ? listModelsByCap(loaded.catalog, 'video') : []),
    [loaded],
  );

  // 选中的模型被删掉（或第一次进入）→ 回落到第一个
  const current: VideoModelRef | undefined =
    models.find((model) => modelKey(model) === selectedKey) ?? models[0];

  const wiring = useMemo(() => {
    if (!current) return null;
    const connection = activeConnectionFor(loaded?.catalog ?? EMPTY_CATALOG, current.providerId);
    return adapterForModel(
      {
        modelId: current.modelId,
        baseUrl: connection?.baseUrl ?? '',
        apiKey: connection?.apiKey ?? '',
      },
      { arkAdapter, zhipuAdapter },
    );
  }, [current, loaded?.catalog, arkAdapter, zhipuAdapter]);

  /**
   * 计费倍率（M3R4 §4.2）：取当前模型所属厂商的 activeConnection 上的倍率。
   * 缺省 = 1（官方价），与旧行为完全一致。
   */
  const multiplier = useMemo(() => {
    if (!current || !loaded) return 1;
    return multiplierOf(activeConnectionFor(loaded.catalog, current.providerId));
  }, [current, loaded]);

  const handleSpend = useCallback(
    async (amount: number) => {
      onSpend?.(amount);
      // 免费模型根本不会走到这里（面板不调用 onSpend），所以这里记录的必然是付费花费
      const next = await recordSpend(amount);
      setSpentValue(next.spent);
    },
    [onSpend],
  );

  if (!loaded) {
    return (
      <div className="video-section">
        <section className="card">
          <p className="muted small">正在读取模型表…</p>
        </section>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="video-section">
        <section className="card" data-testid="video-model-empty">
          <h3>视频生成</h3>
          <p className="warn-inline">{VIDEO_MODEL_EMPTY_HINT}</p>
          <p className="muted small">
            <a className="muted guide-link" href="#/ai-config">
              去 AI 配置
            </a>{' '}
            （选好厂商 → 填连接 → 点标签；带「视频」能力的模型会自动出现在这里）
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="video-section">
      <section className="card">
        <h3>视频生成</h3>
        <label className="field">
          <span>视频模型</span>
          <select
            aria-label="视频模型"
            value={modelKey(current)}
            onChange={(event) => {
              setSelectedKey(event.target.value);
            }}
          >
            {models.map((model) => (
              <option key={modelKey(model)} value={modelKey(model)}>
                {model.displayName || model.modelId}（{model.providerName}）
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          模型来自 AI 配置的模型表（带「视频」能力标签的那些）：选哪个就用哪个，付费模型按 token
          计费，免费模型不计费但要排队。成片一律自动下载到本地库（官方地址 24 小时后失效）。
          换模型就是换生成接口：参数按该模型的能力自动启用/禁用（不支持的项直接灰掉并说明原因）。
        </p>
        {!current.usable && (
          <p className="warn-inline">
            这个模型所属的厂商还没有填服务地址：去「AI 配置」给 {current.providerName} 填一条连接。
          </p>
        )}
      </section>

      {wiring?.ok ? (
        <VideoGenerationPanel
          key={modelKey(current)}
          adapter={wiring.adapter}
          capabilities={wiring.capabilities}
          channelLabel={current.displayName || current.modelId}
          priceTable={wiring.priceTable}
          priceModel={wiring.priceModel}
          multiplier={multiplier}
          spent={spentValue}
          budgetLimit={loaded.budgetLimit ?? null}
          askBeforeSubmit
          onSpend={(amount) => void handleSpend(amount)}
          pollIntervalMs={pollIntervalMs}
          pollTimeoutMs={pollTimeoutMs}
          now={now}
          sleep={sleep}
          readFile={readFile}
        />
      ) : (
        <section className="card" data-testid="video-model-unwired">
          <p className="warn-inline">{wiring?.reason ?? '这个模型现在用不了'}</p>
          {wiring?.hint ? <p className="muted small">{wiring.hint}</p> : null}
        </section>
      )}
    </div>
  );
}
