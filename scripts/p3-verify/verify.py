"""P3 真浏览器验收（Edge + CDP）+ 4 张截图。

流程：造数据 → 打开 /studio → 逐条做任务书 §6 的八项检查 → 出 docs/P3-shots/*.png

所有断言都读**真实渲染出来的 DOM**（counts / aria-pressed / settings 里的草稿），
不读内存里的假设；AI 那一项走的是真的 fetch（打到本地 8787 的 mock 模型服务）。
"""
import base64
import json
import sys
import time

sys.path.insert(0, r"D:/selfdownload/Hermes Agent CN Desktop/data/hermes-home/skills/software-development/edge-cdp-page-automation/scripts")
from cdp import Browser  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://127.0.0.1:5173/"
SHOTS = r"E:/study/auto/code/Inspiration_Assistant_v2/docs/P3-shots"

results = []


def log(name, value):
    results.append({"check": name, "value": value})
    print(json.dumps({"check": name, "value": value}, ensure_ascii=False), flush=True)


def shot(b, sid, name):
    r = b.send("Page.captureScreenshot", session=sid, format="png")
    path = f"{SHOTS}/{name}"
    with open(path, "wb") as handle:
        handle.write(base64.b64decode(r["data"]))
    print(f"[shot] {path}", flush=True)


def goto(b, sid, url, settle=2.6):
    """导航 + **强制 reload**：同一个 hash 上 Page.navigate 不会重新挂载组件。"""
    b.send("Page.navigate", session=sid, url=url)
    time.sleep(0.3)
    b.send("Page.reload", session=sid)
    time.sleep(settle)
    b.evaluate(sid, TYPE_HELPER)


TYPE_HELPER = """
window.__p3type = (selector, text) => {
  const el = document.querySelector(selector);
  if (!el) return 'NO_ELEMENT';
  const setter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return String(el.value.length);
};
window.__p3click = (selector, index) => {
  const list = document.querySelectorAll(selector);
  const el = list[index || 0];
  if (!el) return 'NO_ELEMENT';
  el.click();
  return 'clicked:' + (el.textContent || '').trim().slice(0, 20);
};
'ok'
"""

SEED = """
(async () => {
  const storage = await import('/src/core/storage/index.ts');
  try { await storage.destroyDatabase(); } catch (error) { /* 首次打开时库还不存在 */ }
  const rec = await import('/src/core/records/index.ts');
  const lib = await import('/src/core/library/index.ts');
  const theme = await import('/src/core/theme/session.ts');
  const catalog = await import('/src/adapters/ai-models/catalog.ts');
  const draft = await import('/src/core/studio/draft.ts');

  const rows = [
    { text: '凌晨三点的梦：一座会呼吸的图书馆，书页像潮水一样翻动。', tags: ['梦'] },
    { text: '想把那段地铁里的声音做成一首歌，报站声当鼓点。', tags: ['灵感'] },
    { text: '一个关于「把梦存进盒子」的短片脚本开头。', tags: ['脚本'] },
    { text: '没有窗户的厨房，汤里浮着一把钥匙。母亲说先喝汤。', tags: ['梦'] },
    { text: '镜子里的人总是慢半拍。我抬手，她两秒后才抬。', tags: ['梦'] },
    { text: '退潮后的沙滩上有一艘白船，没有桨，船底结着盐。', tags: ['灵感'] },
    { text: '书店二楼有个只在下雨天开门的房间。', tags: ['脚本'] },
    { text: '电梯按到不存在的负一层，门开是一片麦田。', tags: ['梦'] }
  ];
  const ids = [];
  for (const row of rows) {
    const entity = await rec.createRecord(row);
    ids.push(entity.id);
    await new Promise((r) => setTimeout(r, 12));
  }

  const library = await lib.createCollection('我的短片');
  const collectionId = library.collections[0].id;
  for (const id of ids.slice(0, 3)) await lib.addToCollection(collectionId, id);
  // 置顶第 1 条（最早创建的那条，后面不会被删）
  await lib.setPinned(ids[0], true);

  await theme.saveThemeSetting('clay');
  await draft.saveDraft({ body: '', materialIds: [], updatedAt: 0 });

  await catalog.saveCatalog({
    providers: [{
      id: 'custom:mock',
      name: '本地 mock 模型',
      builtin: false,
      activeConnectionId: 'conn-mock',
      connections: [{
        id: 'conn-mock',
        label: '本地 mock',
        baseUrl: 'http://127.0.0.1:8787',
        apiKey: 'mock',
        protocol: 'openai',
        models: [{ id: 'm-mock', displayName: 'mock-writer', modelId: 'mock-writer', caps: ['text'], enabled: true }]
      }]
    }],
    updatedAt: 0
  });

  const check = await lib.loadLibrary();
  return JSON.stringify({ records: ids.length, pins: check.pins.length, collectionId });
})()
"""


def main():
    b = Browser()
    tid, sid = b.new_page(BASE)
    b.send("Emulation.setDeviceMetricsOverride", session=sid, width=1440, height=900, deviceScaleFactor=1, mobile=False)
    b.send("Runtime.enable", session=sid)
    time.sleep(2.0)

    log("seed", b.evaluate(sid, SEED))

    # ---- 截图 1：clay 主题（2 条素材 + 正文）----
    goto(b, sid, BASE + "#/studio")
    log("materials_rendered", b.evaluate(sid, "document.querySelectorAll('[data-studio-material]').length"))
    b.evaluate(sid, "__p3click('[data-studio-material]', 0)")
    b.evaluate(sid, "__p3click('[data-studio-material]', 1)")
    time.sleep(0.4)
    log("cards_after_select_2", b.evaluate(sid, "document.querySelectorAll('[data-studio-card]').length"))
    BODY = (
        "图书馆在呼吸。\n\n"
        "不是比喻——书页真的在起伏，像退潮后还留在沙上的水。我站在过道中间，能听见它们翻动的声音，"
        "一页一页，从远到近，再从近到远。\n\n"
        "她坐在最里面那张长桌旁，面前摊着一本地铁线路图。报站声从书脊里漏出来：「下一站，终点站。」"
    )
    b.evaluate(sid, f"__p3type('[data-studio-body]', {json.dumps(BODY, ensure_ascii=False)})")
    time.sleep(1.2)
    log("save_state", b.evaluate(sid, "(document.querySelector('[data-studio-save]')||{}).dataset?.studioSave"))
    log("layout_clay", b.evaluate(sid, """JSON.stringify({
      innerHeight: window.innerHeight,
      docScroll: document.documentElement.scrollHeight,
      studioBottom: Math.round(document.querySelector('.page-studio').getBoundingClientRect().bottom)
    })"""))
    shot(b, sid, "studio-clay.png")

    # ---- 截图 2：amber 主题 ----
    b.evaluate(sid, "(async()=>{const t=await import('/src/core/theme/session.ts'); await t.saveThemeSetting('amber'); return 'ok';})()")
    time.sleep(0.6)
    log("theme_now", b.evaluate(sid, "document.documentElement.dataset.theme || document.documentElement.getAttribute('data-theme')"))
    shot(b, sid, "studio-amber.png")

    # ---- 截图 3：未选素材的引导态（clay）----
    b.evaluate(sid, "(async()=>{const t=await import('/src/core/theme/session.ts'); await t.saveThemeSetting('clay'); const d=await import('/src/core/studio/draft.ts'); await d.saveDraft({body:'', materialIds:[], updatedAt:0}); return 'ok';})()")
    goto(b, sid, BASE + "#/studio")
    log("empty_guide_present", b.evaluate(sid, "!!document.querySelector('[data-studio-empty]')"))
    log("empty_guide_text", b.evaluate(sid, "(document.querySelector('[data-studio-empty]')||{}).innerText"))
    shot(b, sid, "studio-empty.png")

    # ---- 截图 4：AI 回复 + 用这版替换正文 ----
    b.evaluate(sid, "__p3click('[data-studio-material]', 0)")
    b.evaluate(sid, "__p3click('[data-studio-material]', 1)")
    time.sleep(0.3)
    b.evaluate(sid, f"__p3type('[data-studio-body]', {json.dumps('图书馆在呼吸。', ensure_ascii=False)})")
    b.evaluate(sid, "__p3type('.studio-ask', '把这两条拧成一个短片开场，200 字以内，不要解释。')")
    time.sleep(0.3)
    log("send_button", b.evaluate(sid, "!!document.querySelector('[data-studio-send]')"))
    b.evaluate(sid, "__p3click('[data-studio-send]', 0)")
    time.sleep(2.5)
    log("ai_reply_present", b.evaluate(sid, "document.querySelectorAll('[data-studio-message=\\\"ai\\\"]').length"))
    log("replace_button_present", b.evaluate(sid, "!!document.querySelector('[data-studio-use]')"))
    b.evaluate(sid, "__p3click('[data-studio-use]', 0)")
    time.sleep(0.5)
    log("confirm_bar_present", b.evaluate(sid, "!!document.querySelector('[data-studio-confirm-replace]')"))
    log("body_unchanged_before_confirm", b.evaluate(sid, "document.querySelector('[data-studio-body]').value"))
    shot(b, sid, "studio-ai.png")
    b.evaluate(sid, "__p3click('[data-studio-confirm-replace]', 0)")
    time.sleep(1.2)
    log("body_after_confirm", b.evaluate(sid, "document.querySelector('[data-studio-body]').value.slice(0, 24)"))

    # ================= 八项真浏览器验证 =================

    # ① #/canvas → #/studio
    goto(b, sid, BASE + "#/canvas")
    log("1_canvas_hash", b.evaluate(sid, "location.hash"))
    log("1_canvas_text_ok", b.evaluate(sid, "document.body.innerText.includes('写作工作台') && !document.body.innerText.includes('页面不存在')"))

    # ② 勾选 2 条 → 2 张卡 + 左侧两项打勾
    goto(b, sid, BASE + "#/studio")
    b.evaluate(sid, "(async()=>{const d=await import('/src/core/studio/draft.ts'); await d.saveDraft({body:'', materialIds:[], updatedAt:0}); return 'ok';})()")
    goto(b, sid, BASE + "#/studio")
    b.evaluate(sid, "__p3click('[data-studio-material]', 0)")
    b.evaluate(sid, "__p3click('[data-studio-material]', 1)")
    time.sleep(0.3)
    log("2_cards", b.evaluate(sid, "document.querySelectorAll('[data-studio-card]').length"))
    log("2_checked", b.evaluate(sid, "document.querySelectorAll('[data-studio-material][aria-pressed=\\\"true\\\"]').length"))

    # ③ 再勾两条（共 4 次点击）→ 卡片最多 3 张，第 4 条给提示且不勾上
    b.evaluate(sid, "__p3click('[data-studio-material]', 2)")
    time.sleep(0.2)
    b.evaluate(sid, "__p3click('[data-studio-material]', 3)")
    time.sleep(0.3)
    log("3_cards", b.evaluate(sid, "document.querySelectorAll('[data-studio-card]').length"))
    log("3_notice", b.evaluate(sid, "(document.querySelector('.studio-notice')||{}).textContent"))
    log("3_fourth_checked", b.evaluate(sid, "document.querySelectorAll('[data-studio-material]')[3].getAttribute('aria-pressed')"))

    # ④ 正文输入 → 刷新 → 内容还在（顺带测自动保存延迟）
    latency = b.evaluate(sid, """
    (async () => {
      const draft = await import('/src/core/studio/draft.ts');
      const mark = '延迟实测-' + Date.now();
      const t0 = performance.now();
      __p3type('[data-studio-body]', mark);
      for (let i = 0; i < 400; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        const saved = await draft.loadDraft();
        if (saved.body === mark) return Math.round(performance.now() - t0);
      }
      return -1;
    })()
    """)
    log("4_autosave_latency_ms", latency)
    goto(b, sid, BASE + "#/studio")
    log("4_body_after_reload", b.evaluate(sid, "document.querySelector('[data-studio-body]').value"))
    log("4_cards_after_reload", b.evaluate(sid, "document.querySelectorAll('[data-studio-card]').length"))

    # ⑤ 关闭一张卡 → 卡片消失 + 左侧取消勾选
    before_cards = b.evaluate(sid, "document.querySelectorAll('[data-studio-card]').length")
    before_checked = b.evaluate(sid, "document.querySelectorAll('[data-studio-material][aria-pressed=\\\"true\\\"]').length")
    b.evaluate(sid, "__p3click('.studio-card-close', 0)")
    time.sleep(0.5)
    after_cards = b.evaluate(sid, "document.querySelectorAll('[data-studio-card]').length")
    after_checked = b.evaluate(sid, "document.querySelectorAll('[data-studio-material][aria-pressed=\"true\"]').length")
    log("5_cards", "{} -> {}".format(before_cards, after_cards))
    log("5_checked", "{} -> {}".format(before_checked, after_checked))

    # ⑥ 没有文本模型 → 可执行提示、无发送按钮
    b.evaluate(sid, """
    (async () => {
      const catalog = await import('/src/adapters/ai-models/catalog.ts');
      await catalog.saveCatalog({
        providers: [{
          id: 'custom:mock', name: '本地 mock 模型', builtin: false, activeConnectionId: 'conn-mock',
          connections: [{ id: 'conn-mock', label: '本地 mock', baseUrl: 'http://127.0.0.1:8787', apiKey: 'mock',
            protocol: 'openai', models: [{ id: 'm-img', displayName: 'cogview-4', modelId: 'cogview-4', caps: ['image'], enabled: true }] }]
        }], updatedAt: 0 });
      return 'ok';
    })()
    """)
    goto(b, sid, BASE + "#/studio")
    log("6_hint_present", b.evaluate(sid, "!!document.querySelector('[data-studio-ai-hint]')"))
    log("6_hint_text", b.evaluate(sid, "(document.querySelector('[data-studio-ai-hint]')||{}).innerText"))
    log("6_send_button", b.evaluate(sid, "!!document.querySelector('[data-studio-send]')"))

    # ⑦ 删掉一条被引用的记录 → 刷新不报错、草稿清掉死 id
    removed = b.evaluate(sid, """
    (async () => {
      const draft = await import('/src/core/studio/draft.ts');
      const rec = await import('/src/core/records/index.ts');
      const current = await draft.loadDraft();
      const target = current.materialIds[current.materialIds.length - 1];
      await rec.removeRecord(target);
      return JSON.stringify({ removed: target, before: current.materialIds.length, body: current.body.slice(0, 12) });
    })()
    """)
    log("7_removed", removed)
    goto(b, sid, BASE + "#/studio")
    log("7_error_shown", b.evaluate(sid, "!!document.querySelector('.error')"))
    log("7_cards", b.evaluate(sid, "document.querySelectorAll('[data-studio-card]').length"))
    log("7_draft_ids", b.evaluate(sid, "(async()=>{const d=await import('/src/core/studio/draft.ts'); const x=await d.loadDraft(); return JSON.stringify({ids:x.materialIds.length, body:x.body.slice(0,10)});})()"))

    # ⑧ 首页「全部 N」与置顶数对得上
    pin = b.evaluate(sid, """
    (async () => {
      const lib = await import('/src/core/library/index.ts');
      const rec = await import('/src/core/records/index.ts');
      const list = await rec.listRecords({ page: 1, pageSize: 50 });
      const target = list.items[0].id;
      const next = await lib.setPinned(target, true);
      return JSON.stringify({ pinned: next.pins.length });
    })()
    """)
    log("8_pin", pin)
    goto(b, sid, BASE + "#/")
    log("8_total_line", b.evaluate(sid, "(document.querySelector('.records-total')||{}).textContent"))
    log("8_all_title", b.evaluate(sid, "(document.querySelector('.library-section-title')||{}).textContent"))
    log("8_pinned_cards", b.evaluate(sid, "document.querySelectorAll('.pinned-card').length"))
    log("8_all_cards", b.evaluate(sid, "document.querySelectorAll('.record-item').length"))
    log("8_page_fills", b.evaluate(sid, "JSON.stringify({h: window.innerHeight, scroll: document.documentElement.scrollHeight})"))

    print("\n=== SUMMARY ===", flush=True)
    for row in results:
        print(f"{row['check']}: {row['value']}", flush=True)

    b.send("Target.closeTarget", targetId=tid)


if __name__ == "__main__":
    main()
