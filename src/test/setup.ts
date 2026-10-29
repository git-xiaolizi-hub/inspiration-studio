// jsdom 不自带 IndexedDB，用 fake-indexeddb 提供与浏览器行为一致的内存实现
import 'fake-indexeddb/auto';

/**
 * fake-indexeddb 用 `structuredClone` 模拟浏览器的结构化克隆。
 *
 * 问题：jsdom 的 `Blob` 不是 Node 的 `Blob`，Node 的 `structuredClone` 不认它，
 * 会把 Blob 克隆成一个空对象（`{}`）—— 于是"音频存进 IndexedDB 再读出来"会
 * 变成 `{ size: undefined }`，测试永远测不出真实行为。
 * 真实浏览器里 Blob 是支持结构化克隆的，所以这里是**测试环境保真度问题**，
 * 只在测试 setup 里给 Blob 补上克隆语义（Blob 不可变，直接透传原实例即可）。
 * 产品代码保持标准 Blob 语义，不为测试做妥协。
 */
const nativeStructuredClone = globalThis.structuredClone;

function isPlainObjectLike(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clonePreservingBlobs<T>(value: T): T {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (Array.isArray(value)) {
    return value.map((item) => clonePreservingBlobs(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object' && isPlainObjectLike(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = clonePreservingBlobs(item);
    }
    return copy as unknown as T;
  }
  return nativeStructuredClone(value);
}

if (typeof nativeStructuredClone === 'function') {
  globalThis.structuredClone = clonePreservingBlobs;
}

/**
 * 测试环境禁止真实网络（M2.5 起）。
 *
 * 背景：本地识别会探测 `public/models/` 是否存在；在 jsdom 里这会被解析成
 * `http://localhost:3000/models/...` 并真的去连一次 socket。测试里不允许有这种
 * "看起来是 mock、其实在发请求" 的行为 —— 默认让 fetch 立刻失败，
 * 需要网络的用例必须显式 stub（M2 的语音设置用例就是这么做的）。
 */
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = (() =>
    Promise.reject(new Error('测试环境禁止真实网络请求：请显式 stub fetch'))) as typeof fetch;
}

/**
 * jsdom 没有实现 `window.scrollTo`（调用只会往 stderr 打 "Not implemented: window.scrollTo"）。
 *
 * 产品代码里它是「点首页回到列表顶部」（P1.5 §3）的必需动作，会出现在列表页挂载时，
 * 于是每个渲染首页的用例都会刷一段 jsdom 的假错误 —— 那不是产品问题，是环境缺失。
 * 这里补一个 no-op 让无关用例的输出保持干净；**要断言滚动行为的用例自己 spyOn 覆盖**
 * （见 src/ui/nav.test.tsx「点「首页」回到列表顶部」）。
 */
if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
  window.scrollTo = (() => {}) as typeof window.scrollTo;
}
