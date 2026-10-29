# P3 真机验收脚本（可复跑）

这两个脚本是 `docs/P3-REPORT.md` §4 / §10 那些数字的来源。它们**不在** `npm run` 的判据里，
是给人复跑用的。

## 前置

1. `npm run dev`（5173 端口）
2. 本机 Edge（没有 Chrome）——脚本用 CDP 驱动：先用 `edge-cdp-page-automation` 技能里的
   `scripts/launch_edge.py` 起一个 9222 的实例
3. `pip install websocket-client`

## 跑法

```bash
python scripts/p3-verify/mock_llm.py        # 终端 A：本地 127.0.0.1:8787 的 OpenAI 兼容桩
python scripts/p3-verify/verify.py          # 终端 B：造数据 + 八项检查 + 4 张截图
```

## 两条硬规矩

- **不许把 `verify.py` 指向真实厂商**：CHARTER §13.2 规定 AI 不得为验收发起付费调用。
  它用 mock 服务是为了让 UI 里的回复**真的是走一遍 `chat()` 回来的**（预检 + POST 都是真请求），
  不是为了编一个好看的截图。
- 脚本会 `destroyDatabase()` 清库再造数据 —— **只在开发用的浏览器 profile 上跑**。

脚本里 `Browser` 的 import 路径指向本机技能目录（`edge-cdp-page-automation/scripts/cdp.py`），
换机器时改那一行即可。
