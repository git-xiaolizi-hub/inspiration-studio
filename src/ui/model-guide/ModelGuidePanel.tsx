/**
 * 「了解如何选择厂商与模型？」指向的文档页（M3R §5 / M3R2 §4 §5）。
 *
 * 只做排版：数据全部来自 `adapters/ai-models/model-guide.ts`
 * （那份数据是从 `docs/reference/vendor-model-guide.draft.md` 搬过来的，
 * 承接方亲自填写）。
 *
 * 三条展示纪律：
 * 1. 顶部必须写明「最后更新」与「时效性由开发者手动维护」；
 * 2. 价格一律标出单位与来源状态（已核实 / 未核实），不给没有来源的数字；
 * 3. 带邀请码的注册链接必须带上「开发者推荐 · 含邀请码」标签，不伪装成官方地址。
 */
import {
  GUIDE_CAP_ORDER,
  GUIDE_CUSTOM_RELAY_NOTE,
  GUIDE_EXAMPLES,
  GUIDE_LOCAL_DEPLOY_NOTE,
  GUIDE_MODELS,
  GUIDE_PICKING_ADVICE,
  GUIDE_VENDOR_INTROS,
  GUIDE_VIDEO_RATES,
  GUIDE_VIDEO_TOKEN_FORMULA,
  GUIDE_VENDORS,
  MODEL_GUIDE_STALENESS_NOTE,
  MODEL_GUIDE_UPDATED,
  modelsByCap,
} from '../../adapters/ai-models/model-guide';
import { CAP_LABELS } from '../../adapters/ai-models/catalog';

function directLabel(direct: '可以' | '需中转' | '本地'): string {
  if (direct === '可以') return '可以';
  if (direct === '本地') return '本地（需 ComfyUI / 自托管）';
  return '不能（需中转）';
}

export function ModelGuidePanel() {
  return (
    <section className="page model-guide">
      <h2>怎么选厂商与模型</h2>
      <p className="muted small" data-testid="guide-updated">
        最后更新：{MODEL_GUIDE_UPDATED}
      </p>
      <p className="muted small">{MODEL_GUIDE_STALENESS_NOTE}</p>

      <section className="card">
        <h3>一、厂商</h3>
        <table className="guide-table">
          <thead>
            <tr>
              <th>厂商</th>
              <th>base_url</th>
              <th>国内可直连</th>
              <th>Key 获取</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {GUIDE_VENDORS.map((vendor) => (
              <tr key={vendor.name} data-vendor={vendor.name}>
                <td>{vendor.name}</td>
                <td>
                  <code>{vendor.baseUrl}</code>
                </td>
                <td>{directLabel(vendor.direct)}</td>
                <td>{vendor.keyUrl}</td>
                <td className="muted small">
                  {vendor.note ?? ''}
                  {vendor.signup ? (
                    <div className="guide-signup">
                      <span className="badge" data-testid="signup-label">
                        {vendor.signup.label}
                      </span>
                      <a href={vendor.signup.url} target="_blank" rel="noreferrer noopener">
                        {vendor.signup.url}
                      </a>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">{GUIDE_CUSTOM_RELAY_NOTE}</p>
        <p className="muted small">{GUIDE_LOCAL_DEPLOY_NOTE}</p>
      </section>

      <section className="card">
        <h3>二、厂商介绍（承接方原文）</h3>
        <p className="muted small">
          下面每段都是开发者原话，只做了分段排版，没有改措辞。共 {GUIDE_VENDOR_INTROS.length} 段。
        </p>
        {GUIDE_VENDOR_INTROS.map((intro) => (
          <div key={intro.vendor} className="vendor-intro" data-vendor-intro={intro.vendor}>
            <h4>{intro.vendor}</h4>
            <p>{intro.text}</p>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>三、模型清单</h3>
        <p className="muted small">
          按能力分组。配置页里点同名预设标签即可把「实际请求模型 + 能力标签 + 备注」一次填好。
          标「未核实」的价格，文档里没给口径，这里不编数字。
        </p>
        {GUIDE_CAP_ORDER.map((cap) => (
          <div key={cap} className="guide-cap-block">
            <h4>能用{cap === 'text' ? '文本' : CAP_LABELS[cap]}的模型</h4>
            <table className="guide-table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>厂商</th>
                  <th>价格</th>
                  <th>推荐</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {modelsByCap(cap).map((model) => (
                  <tr key={`${model.modelId}-${cap}`}>
                    <td>
                      <code>{model.modelId}</code>
                    </td>
                    <td>{model.vendor}</td>
                    <td>{model.price}</td>
                    <td>{model.badge}</td>
                    <td className="muted small">
                      {model.status}
                      {model.note ? ` · ${model.note}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className="muted small">共 {GUIDE_MODELS.length} 个模型条目（同一模型可按能力出现在多组）。</p>
      </section>

      <section className="card">
        <h3>四、视频计价（火山方舟，元/百万 token）</h3>
        <p className="muted small">
          <code>{GUIDE_VIDEO_TOKEN_FORMULA}</code>；帧率默认 24，按整段乘完再取整（差 ¥0.02 就是这么来的）。
        </p>
        <p className="muted small" data-testid="guide-multiplier">
          表里是<strong>官方单价</strong>。走中转站时按分组倍率计费：<strong>实付 ≈ 官方价 × 倍率</strong>
          （倍率在「AI 配置 → 连接」的「倍率」列里填，默认 1 = 官方价）；视频页的「预计花费」会按它换算并注明倍率。
        </p>
        <table className="guide-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>分辨率</th>
              <th>输入不含视频</th>
              <th>输入含视频</th>
            </tr>
          </thead>
          <tbody>
            {GUIDE_VIDEO_RATES.map((row) => (
              <tr key={`${row.model}-${row.resolution}`}>
                <td>
                  <code>{row.model}</code>
                </td>
                <td>{row.resolution}</td>
                <td>¥{row.withoutInputVideo.toFixed(2)}</td>
                <td>¥{row.withInputVideo.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>三个算例</h4>
        <ul className="guide-examples">
          {GUIDE_EXAMPLES.map((example) => (
            <li key={example.label}>
              {example.label}：<strong>{example.amount}</strong>
              <span className="muted small">（{example.detail}）</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>五、一句话建议</h3>
        <ul className="guide-advice">
          {GUIDE_PICKING_ADVICE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}
