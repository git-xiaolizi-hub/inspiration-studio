# Inspiration Assistant v2

给 AI 视频创作者用的**灵感工作台**：记梦/灵感 → 让模型扩成故事与脚本 → 出分镜 → 生图/生视频。

**纯前端、本地优先**：没有后端、没有账号；数据在浏览器 IndexedDB 里，API Key 由用户自己填。

> **在线试用**：<https://git-xiaolizi-hub.github.io/inspiration-studio/>
>
> 网页版不含本地语音模型（体积原因，仓库不带权重文件）；需要完全离线的语音转写请用桌面版（开发中）。

---

## 跑起来

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

其他常用命令：

```bash
npm run build        # 类型检查 + 生产构建
npm run lint
npm run test         # 803 条单元/组件测试
npm run check:edges  # 真浏览器断言（工作流模板连线渲染）
```

---

## 文档从哪读

**入口只有一个：[`docs/INDEX.md`](docs/INDEX.md)。**

- 要给设计师看：**[`HANDOFF-TO-DESIGNER.md`](HANDOFF-TO-DESIGNER.md)**（自包含）
- 产品契约与决策史：[`docs/CHARTER.md`](docs/CHARTER.md)
- 原始需求：[`docs/IA-v2-requirements.md`](docs/IA-v2-requirements.md)
- 历史任务书与报告：[`docs/archive/milestones/`](docs/archive/milestones/)（61 份，按里程碑归档，**不要当现状读**）

---

## 目录

```
src/core/      数据层（records / artifacts / media / storage / backup / threads / custom-prompts / canvas）
src/adapters/  模型接入（ai-models / image / video / asr）
src/packs/     提示词包运行时与输出校验
src/ui/        界面（pages / create / workflow / ai-config / model-guide / video）
packs/         4 个提示词包（SKILL.md）
scripts/       构建、校验、浏览器验收脚本
docs/          文档（索引、契约、归档）
```

---

## 状态

业务功能已全部实现并通过自动化验收；**界面仍是开发者草稿**，视觉与交互待整体重做（见交接文档）。
