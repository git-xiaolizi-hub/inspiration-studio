"""P3 验收用的本地 mock 模型服务（OpenAI 兼容）。

为什么要它：CHARTER §13.2 规定 AI 不得为验收发起付费调用，但写作工作台的
「AI 回复 → 用这版替换正文」必须**真的走一遍**才能截图（否则截图里的回复是假的）。

所以这里起一个本地 127.0.0.1:8787 的 OpenAI 兼容端点：
应用的 `chat()` → 真实 fetch → 本服务 → 返回固定的写作结果。
链路（请求构造 / 解析 / 错误处理）全是真的，只有「模型」是桩。
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

REPLY = (
    "图书馆在呼吸。书页像退潮后留在沙上的水，一页一页地起伏。\n\n"
    "她坐在地铁线路图前，报站声从书脊里漏出来——「下一站，终点站。」\n\n"
    "没有人下车。门开了很久，风把书翻到同一页。"
)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            request = json.loads(raw or "{}")
        except json.JSONDecodeError:
            request = {}

        body = {
            "id": "chatcmpl-mock-p3",
            "object": "chat.completion",
            "model": request.get("model", "mock-writer"),
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 120, "completion_tokens": 90, "total_tokens": 210},
        }
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print("[mock-llm] " + fmt % args, flush=True)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8787), Handler).serve_forever()
