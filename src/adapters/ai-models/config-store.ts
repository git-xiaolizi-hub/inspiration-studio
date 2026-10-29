/**
 * AI 配置与花费的本地持久化 + 导入导出（M3 交付物 6）。
 *
 * 存储位置：沿用 M1 定的 `settings` 表（IndexedDB），key 分别为
 * `ai-config` / `ai-spend` / `ai-price-table`——**不引入后端，key 只在本机浏览器里**。
 *
 * 两个硬要求：
 * - 导入导出**走文件**（下载 .json / 选择文件导入），不走剪贴板（硬约束 4）；
 * - key **默认明文**存本地，UI 必须给出警告；导出时默认**不含** key，
 *   只有用户显式勾选「包含 API Key」才会写进文件。任何情况下都不写日志、不写报告。
 */
import { getSetting, putSetting } from '../../core/storage';
import { clonePriceTable, OFFICIAL_PRICE_TABLE } from './pricing';
import type { PriceTable } from './pricing';

export const AI_CONFIG_KEY = 'ai-config';
export const AI_SPEND_KEY = 'ai-spend';
export const AI_PRICE_TABLE_KEY = 'ai-price-table';

export type ProviderProtocol = 'openai' | 'anthropic';

export interface AIConfig {
  providerId: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 拉取到的模型列表（手填前留空即可） */
  models: string[];
  /** 预算上限（元）；null = 不设 */
  budgetLimit: number | null;
  updatedAt: number;
}

export function defaultAIConfig(): AIConfig {
  return {
    providerId: 'openai',
    protocol: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    models: [],
    budgetLimit: null,
    updatedAt: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asProtocol(value: unknown): ProviderProtocol {
  return value === 'anthropic' ? 'anthropic' : 'openai';
}

/** 把库里的（可能是旧版本/被手改过的）对象收敛成合法 AIConfig */
export function normalizeConfig(value: unknown): AIConfig {
  const row = asRecord(value) ?? {};
  const models = Array.isArray(row.models)
    ? row.models.filter((item): item is string => typeof item === 'string')
    : [];
  const budgetRaw = row.budgetLimit;
  const budgetLimit =
    typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) && budgetRaw >= 0 ? budgetRaw : null;
  return {
    providerId: asString(row.providerId, 'openai'),
    protocol: asProtocol(row.protocol),
    baseUrl: asString(row.baseUrl).trim(),
    apiKey: asString(row.apiKey).trim(),
    model: asString(row.model).trim(),
    models,
    budgetLimit,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
  };
}

export async function loadAIConfig(): Promise<AIConfig> {
  const row = await getSetting(AI_CONFIG_KEY);
  if (!row || row.value === undefined) return defaultAIConfig();
  return normalizeConfig(row.value);
}

export async function saveAIConfig(patch: Partial<Omit<AIConfig, 'updatedAt'>>): Promise<AIConfig> {
  const existing = await loadAIConfig();
  const next = normalizeConfig({ ...existing, ...patch, updatedAt: Date.now() });
  await putSetting({ key: AI_CONFIG_KEY, value: next, updatedAt: next.updatedAt });
  return next;
}

/* ------------------------------------------------------------------ */
/* 花费累计                                                           */
/* ------------------------------------------------------------------ */

export interface SpendState {
  /** 已累计花费（元） */
  spent: number;
  updatedAt: number;
}

export async function loadSpend(): Promise<SpendState> {
  const row = await getSetting(AI_SPEND_KEY);
  const value = asRecord(row?.value);
  const spent = typeof value?.spent === 'number' && Number.isFinite(value.spent) ? value.spent : 0;
  return { spent, updatedAt: typeof value?.updatedAt === 'number' ? value.updatedAt : 0 };
}

export async function recordSpend(amount: number): Promise<SpendState> {
  const current = await loadSpend();
  const delta = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const next: SpendState = { spent: current.spent + delta, updatedAt: Date.now() };
  await putSetting({ key: AI_SPEND_KEY, value: next, updatedAt: next.updatedAt });
  return next;
}

export async function resetSpend(): Promise<SpendState> {
  const next: SpendState = { spent: 0, updatedAt: Date.now() };
  await putSetting({ key: AI_SPEND_KEY, value: next, updatedAt: next.updatedAt });
  return next;
}

/* ------------------------------------------------------------------ */
/* 价格表（可配置）                                                    */
/* ------------------------------------------------------------------ */

function looksLikePriceTable(value: unknown): value is PriceTable {
  const row = asRecord(value);
  if (!row) return false;
  const models = asRecord(row.models);
  return Boolean(models) && typeof row.source === 'string' && typeof row.verified === 'boolean';
}

export async function loadPriceTable(): Promise<PriceTable> {
  const row = await getSetting(AI_PRICE_TABLE_KEY);
  return looksLikePriceTable(row?.value) ? (row.value as PriceTable) : clonePriceTable(OFFICIAL_PRICE_TABLE);
}

export async function savePriceTable(table: PriceTable): Promise<PriceTable> {
  await putSetting({ key: AI_PRICE_TABLE_KEY, value: table, updatedAt: Date.now() });
  return table;
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入（走文件）                                               */
/* ------------------------------------------------------------------ */

export const AI_CONFIG_FILE_FORMAT = 'inspiration-assistant-ai-config';
export const AI_CONFIG_FILE_VERSION = 1;

export interface AIConfigFile {
  format: typeof AI_CONFIG_FILE_FORMAT;
  version: number;
  exportedAt: string;
  /** 这份文件里到底有没有 key —— 导入时也知道自己拿到了什么 */
  containsKey: boolean;
  config: Omit<AIConfig, 'apiKey'> & { apiKey?: string };
  priceTable?: PriceTable;
}

export interface BuildFileOptions {
  includeKey?: boolean;
  priceTable?: PriceTable | null;
  now?: Date;
}

export function buildConfigFile(config: AIConfig, options: BuildFileOptions = {}): AIConfigFile {
  const includeKey = options.includeKey === true;
  const { apiKey, ...rest } = normalizeConfig(config);
  const file: AIConfigFile = {
    format: AI_CONFIG_FILE_FORMAT,
    version: AI_CONFIG_FILE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    containsKey: includeKey && apiKey !== '',
    config: includeKey ? { ...rest, apiKey } : rest,
  };
  if (options.priceTable) file.priceTable = options.priceTable;
  return file;
}

export function configFileName(now: Date = new Date()): string {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `ai-config_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}

export function serializeConfigFile(config: AIConfig, options: BuildFileOptions = {}): {
  json: string;
  filename: string;
  containsKey: boolean;
} {
  const file = buildConfigFile(config, options);
  return { json: JSON.stringify(file, null, 2), filename: configFileName(options.now), containsKey: file.containsKey };
}

export type ParseConfigResult =
  | { ok: true; config: AIConfig; priceTable?: PriceTable; containsKey: boolean }
  | { ok: false; error: string };

/**
 * 解析导入文件。永不抛异常：任何不合法的输入都返回 `ok:false` + 人话原因。
 * 注意：文件里没有 key 时，**保留当前配置里的 key**（由调用方决定合并策略）。
 */
export function parseConfigFile(text: string): ParseConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '这不是合法的 JSON 文件，请选择由本应用导出的 .json 配置' };
  }
  const row = asRecord(raw);
  if (!row) return { ok: false, error: '配置文件内容不是对象，无法识别' };
  if (row.format !== AI_CONFIG_FILE_FORMAT) {
    return { ok: false, error: `不是本应用的 AI 配置文件（format=${String(row.format)}）` };
  }
  if (typeof row.version !== 'number' || row.version > AI_CONFIG_FILE_VERSION) {
    return {
      ok: false,
      error: `配置版本 ${String(row.version)} 太新，当前应用只认到 v${AI_CONFIG_FILE_VERSION}，请升级后再导入`,
    };
  }
  const configRow = asRecord(row.config);
  if (!configRow) return { ok: false, error: '配置文件缺少 config 字段' };

  const config = normalizeConfig(configRow);
  const containsKey = typeof configRow.apiKey === 'string' && configRow.apiKey !== '';
  const priceTable = looksLikePriceTable(row.priceTable) ? (row.priceTable as PriceTable) : undefined;
  return { ok: true, config, priceTable, containsKey };
}
