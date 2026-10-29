# packs/ —— 提示词工程包

每个子目录是一份 `SKILL.md`：YAML frontmatter（机器读）+ Markdown 正文（模型读）。

当前 4 个：

| pack | 用途 | 关键输出字段 |
|---|---|---|
| `dream-interpretation` | 解梦（心理联想视角，含免责） | `interpretation` / `symbols[]` / `disclaimer` |
| `story-expansion` | 一条记录 → 3 个故事方向 | `directions[]`（含 `why_it_holds`） |
| `image-prompt-optimizer` | 生图提示词（五要素 + 参数单列） | `positive` / `negative` / `elements` / `params` |
| `video-storyboard` | 锚点块 + 首尾帧分镜 + 接续 SOP | `anchors` / `keyframes` / `shots` / `continuity_sop` / `params` |

## frontmatter 必填字段（CHARTER §5）

```yaml
name: 唯一名字（= 目录名）
description: 用途一句话
io_contract:
  input: {字段: 类型, 可空字段?: 类型}
  output: {字段: 类型}
validation: [会被程序逐条判定的硬条款]
forbidden: [硬禁止]
```

视频类另有 `anchors` / `keyframe_mode` / `output_includes`，原样解析、不参与通用校验。

类型表达式支持：`string` / `number` / `boolean` / `object` / `Array<前缀>` / `{a: string, b?: number}`，
以及 `string | null`（可空）。

## 正文必备小节

`# 角色`、`# 输入契约`、`# 输出格式`、`# 判据`、`# 禁止项`。
`npm run test:packs` 会检查这五节在不在（缺一节直接失败）。

## 怎么加一个新 pack

1. 建 `packs/<name>/SKILL.md`；
2. 在 `src/packs/validate.ts` 的 `SPECIALIZED` 里登记专用规则（没有专用规则可先不加，通用校验仍会跑）；
3. 在 `test-fixtures/packs/<name>/` 放 `input-1..3.json` 与 `response-1..3.json`；
4. 在 `src/packs/packs.test.ts` 的 `PACK_NAMES` 里加上名字；
5. `npm run test:packs`。

## 纪律

- **内容只放这里**，不要硬编码进 `src/`（`src/packs/` 只有加载器与校验器）。
- 借鉴官方 Seedance 2.5 提示词规范的结构与模板族，但**措辞自己写**、不整段复制。
- **不要**引入官方 skill 里的自升级段（会话首次触发就联网把自己刷到 latest 的那一段）——`checkPackStructure` 会把残留当失败。
- 测试一律注入假模型响应，**不发起真实模型调用**（CHARTER §13.2）。
