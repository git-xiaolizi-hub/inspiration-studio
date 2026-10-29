#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 ModelScope 拉取 whisper-tiny（ONNX 量化版）到本地，供 transformers.js 离线加载。

为什么不用 HuggingFace：本机实测 huggingface.co 与 hf-mirror.com 均 HTTP 000（不可达），
ModelScope 302/0.37s 可达。

用法：
    python scripts/fetch-whisper-model.py                    # 默认 quantized -> public/models/whisper-tiny
    python scripts/fetch-whisper-model.py --variant fp32     # 全精度（约 150 MB）
    python scripts/fetch-whisper-model.py --dest .tmp/m     # 换目录

量化版体积（实测 2026-10-17）：
    onnx/encoder_model_quantized.onnx        9.7 MB
    onnx/decoder_model_merged_quantized.onnx 29.3 MB
    根目录全部分词器/配置                    4.2 MB
    ------------------------------------------------
    合计约 44 MB
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

API = "https://modelscope.cn/api/v1/models/{ns}/{name}/repo/files?Revision={rev}"
DL = "https://modelscope.cn/api/v1/models/{ns}/{name}/repo?Revision={rev}&FilePath={path}"

ONNX_FILES = {
    "quantized": ("onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"),
    "q4f16": ("onnx/encoder_model_q4f16.onnx", "onnx/decoder_model_merged_q4f16.onnx"),
    "fp32": ("onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"),
}


def list_files(ns: str, name: str, rev: str, root: str | None = None) -> list[dict]:
    url = API.format(ns=ns, name=name, rev=rev)
    if root:
        url += "&Root=" + urllib.parse.quote(root)
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)["Data"]["Files"]


def download(url: str, dest: str, expect: int) -> None:
    if os.path.exists(dest) and os.path.getsize(dest) == expect:
        print("  跳过（已完整）  %s" % os.path.basename(dest))
        return
    tmp = dest + ".part"
    done = 0
    with urllib.request.urlopen(url, timeout=180) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if expect > 5 * 1024 * 1024 and done % (5 * 1024 * 1024) < (1 << 16):
                print("    ... %s %.1f/%0.1f MB" % (os.path.basename(dest), done / 1048576, expect / 1048576))
    os.replace(tmp, dest)
    got = os.path.getsize(dest)
    flag = "✓" if got == expect else "⚠️ 大小不符（期望 %d，实得 %d）" % (expect, got)
    print("  完成 %-46s %8.1f MB  %s" % (os.path.basename(dest), got / 1048576, flag))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default="public/models/whisper-tiny")
    ap.add_argument("--ns", default="Xenova")
    ap.add_argument("--name", default="whisper-tiny")
    ap.add_argument("--rev", default="master")
    ap.add_argument("--variant", default="quantized", choices=sorted(ONNX_FILES))
    a = ap.parse_args()

    os.makedirs(os.path.join(a.dest, "onnx"), exist_ok=True)

    wanted: list[tuple[str, int]] = []
    for f in list_files(a.ns, a.name, a.rev):
        if f.get("Type") == "blob":
            wanted.append((f["Path"], f["Size"]))

    enc, dec = ONNX_FILES[a.variant]
    model_paths = {enc, dec}
    for f in list_files(a.ns, a.name, a.rev, "onnx"):
        if f["Path"] in model_paths:
            wanted.append((f["Path"], f["Size"]))

    missing = model_paths - {p for p, _ in wanted}
    if missing:
        print("❌ 仓库里找不到这些 ONNX 文件：", ", ".join(sorted(missing)))
        return 2

    total = sum(s for _, s in wanted)
    print("源：ModelScope %s/%s @%s（%s）" % (a.ns, a.name, a.rev, a.variant))
    print("将下载 %d 个文件，合计 %.1f MB -> %s\n" % (len(wanted), total / 1048576, a.dest))

    for path, size in wanted:
        dest = os.path.join(a.dest, path)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        url = DL.format(ns=a.ns, name=a.name, rev=a.rev,
                        path=urllib.parse.quote(path, safe="/"))
        download(url, dest, size)

    print("\n完成：%s" % os.path.abspath(a.dest))
    print("下一步（应用侧）：把 transformers.js 的 env.localModelPath 指到 public/models，")
    print("并把 env.allowRemoteModels 设为 false —— 运行时不联网拉模型。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
