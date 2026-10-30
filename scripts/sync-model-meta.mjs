/**
 * 同步「模型的真实上下文窗口」。
 *
 * 为什么不在运行时拉：models.dev 的 api.json 有 5.9MB、litellm 的 json 有 3.2MB，
 * 都塞不进 localStorage，也不该让小白每次开弹窗都等网络。
 * 所以做成**构建前跑一次**：抓两份公开名录，压成一张 { modelId: 窗口 } 的小表。
 *
 * 用法：npm run sync:models        （需要能访问外网；国内网络加 HTTPS_PROXY）
 *
 * 数据源（都允许直接 fetch）：
 * - https://models.dev/api.json                                    → provider.models[*].limit.context
 * - https://raw.githubusercontent.com/BerriAI/litellm/main/...json → max_input_tokens
 *
 * 合并规则：**models.dev 优先**（它是模型卡为准的元数据），litellm 只兜底。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '../src/core/model-meta/context.json');

const MD = 'https://models.dev/api.json';
const LITE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const norm = (id) => String(id).toLowerCase().replace(/[^a-z0-9.]/g, '');

/**
 * 取 JSON：优先用环境变量指向的本地文件（`MODELS_DEV_JSON` / `LITELLM_JSON`），
 * 没有再走 fetch。**Node 的 fetch 不认 HTTP_PROXY**，国内网络下先用 curl 下好再指过来：
 *   curl -x http://127.0.0.1:7890 -o md.json https://models.dev/api.json
 *   MODELS_DEV_JSON=md.json LITELLM_JSON=litellm.json npm run sync:models
 */
async function loadJson(url, localPath) {
  if (localPath) {
    console.log(`read ${localPath}`);
    return JSON.parse(readFileSync(localPath, 'utf8'));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const modelsDev = await loadJson(MD, process.env.MODELS_DEV_JSON);
const litellm = await loadJson(LITE, process.env.LITELLM_JSON);

/**
 * modelId → 窗口。
 *
 * 优先级写死：**models.dev 先到先得，litellm 只补空缺**。
 * 不做「取最大值」——两家报同一模型时常常不一致（如 MiniMax-M3 一边 512k 一边 1M），
 * 取大的会让预算过于乐观，正好是我们想避免的那类错。
 */
const table = {};
const put = (id, size) => {
  const key = norm(id);
  const value = Number(size);
  if (!key || !Number.isFinite(value) || value <= 0) return;
  if (table[key]) return; // 先写入的优先
  table[key] = Math.round(value);
};

// ① models.dev（结构：provider → models → { limit: { context } }）
for (const provider of Object.values(modelsDev)) {
  for (const [id, model] of Object.entries(provider?.models ?? {})) {
    put(id, model?.limit?.context);
  }
}

// ② litellm（结构：modelId → { max_input_tokens, max_tokens }）
for (const [id, model] of Object.entries(litellm)) {
  if (!model || typeof model !== 'object') continue;
  if (model.mode && model.mode !== 'chat' && model.mode !== 'responses') continue;
  put(id, model.max_input_tokens ?? model.max_tokens);
}

mkdirSync(dirname(outFile), { recursive: true });
const payload = {
  // 只留窗口，不存价格：价格另有 price-table，混在一起反而没法单独更新
  updatedAt: new Date().toISOString().slice(0, 10),
  source: 'models.dev/api.json + BerriAI/litellm model_prices_and_context_window.json',
  contexts: table,
};
writeFileSync(outFile, JSON.stringify(payload, null, 0) + '\n', 'utf8');

const sizes = Object.keys(table).length;
console.log(`wrote ${outFile}`);
console.log(`models: ${sizes}`);
for (const id of ['deepseekflash', 'glm4.7flash', 'doubao-seed-2-1-pro-260628', 'gemini-4-argon']) {
  console.log(`  ${id} → ${table[id] ?? '(none)'}`);
}
