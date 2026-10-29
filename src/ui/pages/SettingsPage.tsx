import { useCallback, useEffect, useState } from 'react';
import { estimateQuota, getSetting, putSetting } from '../../core/storage';
import type { QuotaSnapshot } from '../../core/storage';
import { countRecords } from '../../core/storage/queries';
import { getVoiceSettings } from '../../core/settings';
import type { VoiceSettings } from '../../core/settings';
import { exportBackupZip, importBackupZip } from '../../core/backup';
import { VoiceSettingsSection } from '../components/VoiceSettingsSection';
import { AIConfigCard } from '../ai-config/AIConfigCard';
import { ThemeSection } from '../components/ThemeSection';
import { Dialog } from '../components/Dialog';
import { reloadThemeFromStorage } from '../../core/theme/session';
import { downloadBlob } from '../download';
import { describeError, formatBytes } from '../format';

/**
 * 设置页。
 *
 * 历史：M5a 把备份收成唯一入口；P1 把纵向堆叠改成「左目录 + 右双栏」；
 * P1.5 按委托人的语义重排四行。**R6 起只有四张半行卡**：
 *
 *   AI 配置    │ 语音识别
 *   外观主题   │ 用户数据
 *
 * R6 删掉了两张卡：
 * - 「快捷创作」——委托人：「完全没有必要，直接从导航栏过去更方便」。
 *   三个磁贴指向的 `/workflow` `/canvas` `/create` 路由**一个都没删**，
 *   顶栏「创作」页照旧可达（`nav.test.tsx` 的九路由用例仍在）。
 * - 「预算限额」——委托人：「我们既不是官方 api 提供者也不是中转站，计价是算不准的」。
 *   **数据层没动**：`settings.budgetLimit` 与 `ai-spend` 字段原样保留（旧备份读得回来），
 *   `budgetLimit: null` 的语义是「永不按总预算拦截」；单次花费的提醒搬到了生视频按钮旁边
 *   （小字预估 + 点击时的确认弹窗，见 `VideoGenerationPanel`）。
 *
 * 「数据大小」与「导入导出」合成一张「用户数据」：控件一个没丢，只改了文案与按钮尺寸。
 */

/** 左目录：四张卡，四项（AI 配置 / 语音识别 / 外观主题 / 用户数据） */
interface RailItem {
  id: string;
  label: string;
  icon: string;
}

/** 第一次「带 API Key 导出」提醒过一次就记下来，之后不再打断（委托人 2026-10-28） */
const KEY_EXPORT_ACK_KEY = 'key-export-acknowledged';

/** 导出设置：一个 zip 里到底装什么（委托人 2026-10-28 要求合并成一个多选下拉） */
type ExportScopeKey = 'records' | 'aiCatalog' | 'key' | 'settings';

/** 导入设置：合并 / 覆盖（覆盖会清空现有数据，所以下拉里要写清楚） */
const IMPORT_MODES: readonly { value: 'merge' | 'replace'; label: string; note: string }[] = [
  { value: 'merge', label: '合并', note: '按 id 覆盖，保留其它记录' },
  { value: 'replace', label: '覆盖', note: '先清空现有数据，再导入' },
];

const EXPORT_SCOPES: readonly { key: ExportScopeKey; label: string; note: string }[] = [
  { key: 'records', label: '记录', note: '含音频' },
  { key: 'aiCatalog', label: 'AI 配置', note: '模型、价格表、自定义提示词' },
  { key: 'key', label: 'API Key', note: '文件会变成明文密码' },
  { key: 'settings', label: '其他设置', note: '主题、语音、模型顺序与角色' },
];

const RAIL: readonly RailItem[] = [
  { id: 'model-vendors', label: 'AI 配置', icon: '◈' },
  { id: 'userdata', label: '用户数据', icon: '▤' },
  { id: 'voice', label: '语音识别', icon: '◉' },
  { id: 'theme', label: '外观主题', icon: '✎' },
];

export function SettingsPage() {
  /** undefined = 加载中，null = 还没设置过 */
  const [voice, setVoice] = useState<VoiceSettings | null | undefined>(undefined);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [records, setRecords] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 用户数据区（导出 / 导入） */
  const [busy, setBusy] = useState<'export' | 'import' | 'ai' | 'records' | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  /** 默认全选（含 API Key）：委托人「大部分时候是自己设备之间传输，反复填 key 太麻烦」。 */
  const [exportScope, setExportScope] = useState<Record<ExportScopeKey, boolean>>({
    records: true,
    aiCatalog: true,
    key: true,
    settings: true,
  });
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  /** null = 还没读出来；读出来之前按「已提醒过」处理，避免一进页面就闪一下弹窗 */
  const [keyExportAck, setKeyExportAck] = useState<boolean | null>(null);
  const [pendingKeyExport, setPendingKeyExport] = useState(false);
  /** 两个下拉互斥：同时只能开一个，否则面板会叠在一起（委托人 2026-10-28 报的 bug） */
  const [openMenu, setOpenMenu] = useState<'export' | 'import' | null>(null);
  const scopeCount = EXPORT_SCOPES.filter((item) => exportScope[item.key]).length;
  /** 和「导入设置 · 合并/覆盖」对称：一眼看出这次导出是全量还是只挑了一部分 */
  const scopeLabel = scopeCount === EXPORT_SCOPES.length ? '全部' : scopeCount === 0 ? '未选' : '部分';

  /** 左目录当前选中项（只是高亮，不参与任何业务判断） */
  const [active, setActive] = useState<string>(RAIL[0].id);

  /**
   * 目录跳转 = 滚动到对应卡片。
   *
   * 为什么是 button + scrollIntoView 而不是 <a href="#外观">：
   * 本应用用 HashRouter，`#` 前面是路由。写锚点会把路由顶掉（直接落到「页面不存在」）。
   */
  const jumpTo = useCallback((id: string): void => {
    setActive(id);
    const target = document.querySelector(`.settings-grid [data-block="${id}"]`);
    if (target instanceof HTMLElement && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const loadBasics = useCallback(async (): Promise<void> => {
    const [settings, snapshot, count] = await Promise.all([
      getVoiceSettings(),
      estimateQuota(),
      countRecords(),
    ]);
    setVoice(settings);
    setQuota(snapshot);
    setRecords(count);
    const ack = await getSetting(KEY_EXPORT_ACK_KEY);
    setKeyExportAck(ack?.value === true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadBasics();
      } catch (caught) {
        if (!cancelled) setError(describeError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBasics]);

  /** 带 Key 导出：第一次先提醒一次，记住之后不再打断 */
  function handleExportBackup(): void {
    if (exportScope.key && keyExportAck !== true) {
      setPendingKeyExport(true);
      return;
    }
    void runExport();
  }

  async function acknowledgeAndExport(): Promise<void> {
    setPendingKeyExport(false);
    setKeyExportAck(true);
    try {
      await putSetting({ key: KEY_EXPORT_ACK_KEY, value: true, updatedAt: Date.now() });
    } catch {
      // 记不住也不该挡住导出：下次再提醒一次而已
    }
    void runExport();
  }

  async function runExport(): Promise<void> {
    setBusy('export');
    setBackupError(null);
    setBackupNotice(null);
    try {
      const result = await exportBackupZip(new Date(), {
        includeKey: exportScope.key,
        include: {
          records: exportScope.records,
          aiCatalog: exportScope.aiCatalog,
          priceTable: exportScope.aiCatalog,
          customPrompts: exportScope.aiCatalog,
          settings: exportScope.settings,
        },
      });
      downloadBlob(result.blob, result.filename);
      const files = result.entries.filter((entry) => !entry.startsWith('media/'));
      setBackupNotice(
        `已导出 ${result.filename}：${files.join('、')}${
          result.manifest.counts.media > 0 ? `、media/（${result.manifest.counts.media} 段音频）` : ''
        }；${result.manifest.containsKey ? '包含 API Key，请当密码保管' : '不含 API Key'}。`,
      );
    } catch (caught) {
      setBackupError(describeError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleImportFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy('import');
    setBackupError(null);
    setBackupNotice(null);
    try {
      const result = await importBackupZip(file, { mode: importMode });
      const parts = [`${result.imported} 条记录`, `${result.media} 段音频`];
      if (result.aiCatalog) parts.push('AI 配置');
      if (result.priceTable) parts.push('价格表');
      if (result.settings > 0) parts.push(`${result.settings} 项设置`);
      if (result.threads > 0) parts.push(`${result.threads} 条会话`);
      setBackupNotice(
        `已导入（${result.mode === 'replace' ? '覆盖模式' : '合并模式'}）：${parts.join(' / ')}${
          result.missingMedia > 0 ? `；${result.missingMedia} 段音频缺失` : ''
        }。`,
      );
      await loadBasics();
      // 主题也随备份进出：导入后立刻生效（不能等刷新才变）
      await reloadThemeFromStorage();
    } catch (caught) {
      setBackupError(describeError(caught));
    } finally {
      setBusy(null);
    }
  }

  /** 进度条：0–100；已用但不足 2% 时留 2% 的可见宽度，否则看起来像「槽里有个点」 */
  const percentUsed = quota ? Math.min(100, Math.max(0, Math.round(quota.percentUsed))) : 0;
  const meterWidth = quota && quota.usage > 0 ? Math.max(2, percentUsed) : 0;

  return (
    <section className="page page-settings">
      <aside className="settings-rail" aria-label="设置目录">
        <p className="settings-rail-title">设置</p>
        {RAIL.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`rail-item ${active === entry.id ? 'is-active' : ''}`}
            aria-current={active === entry.id ? 'true' : undefined}
            onClick={() => jumpTo(entry.id)}
          >
            <i className="rail-item-icon" aria-hidden="true">
              {entry.icon}
            </i>
            {entry.label}
          </button>
        ))}
      </aside>

      <div className="settings-pane">
        <h2 className="settings-title">设置</h2>

        {error && <p className="error">{error}</p>}

        {/* DOM 顺序 = 视觉顺序；grid-area 只负责把两栏钉死，别让读屏和键盘走到另一个顺序上。 */}
        <div className="settings-grid">
          {/* 第一行左：AI 配置（顶栏按 D2 收成三项后搬到这里，保证「收起导航 ≠ 页面失联」）
              R7b：卡片换成三按钮 + 已配置模型标签行 + 详情弹窗，定高 290px（见 AIConfigCard）。
              两个路由入口原样保留：自由配置 → /ai-config，选型指南 → /model-guide。 */}
          <AIConfigCard />

          {/* 第一行右：用户数据（原「数据大小」+「导入导出」合并成一张卡） */}
          <section className="card" data-block="userdata">
            <h3>用户数据</h3>
            <p className="settings-block-sub">一份 zip 装下记录、音频、AI 配置、设置与价格表；数据只存本机，不上传、不联网</p>

            <div className="settings-stats">
              <div className="settings-stat">
                <span className="settings-stat-value">{records === null ? '—' : records}</span>
                <span className="settings-stat-label">条记录</span>
              </div>
              <div className="settings-stat">
                <span className="settings-stat-value">{quota ? formatBytes(quota.usage) : '—'}</span>
                <span className="settings-stat-label">
                  {quota ? `已用 / 上限 ${formatBytes(quota.quota)}` : '当前环境无法查询存储配额'}
                </span>
              </div>
            </div>

            <div
              className="settings-meter"
              role="progressbar"
              aria-label="本地存储占用"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentUsed}
            >
              <i style={{ width: `${meterWidth}%` }} />
            </div>

            {/* 委托人 2026-10-28：一个导出按钮 + 一个「导出设置」多选下拉占一行，
                导入按钮 + 导入设置占一行。导出设置默认全选（含 API Key）。 */}
            <div className="settings-row userdata-actions">
              <button
                type="button"
                className="button primary"
                onClick={handleExportBackup}
                disabled={busy !== null || scopeCount === 0}
                title={scopeCount === 0 ? '至少勾选一项才能导出' : undefined}
              >
                {busy === 'export' ? '导出中…' : '导出备份'}
              </button>

              <details
                className="scope-menu"
                open={openMenu === 'export'}
                onToggle={(event) => {
                  const isOpen = event.currentTarget.open;
                  if (isOpen) setOpenMenu('export');
                  else setOpenMenu((current) => (current === 'export' ? null : current));
                }}
              >
                <summary className="button ghost">导出设置 · {scopeLabel}</summary>
                <div className="scope-panel">
                  {EXPORT_SCOPES.map((item) => (
                    <label className="scope-item" key={item.key}>
                      <input
                        type="checkbox"
                        checked={exportScope[item.key]}
                        onChange={(event) =>
                          setExportScope((current) => ({
                            ...current,
                            [item.key]: event.target.checked,
                          }))
                        }
                      />
                      <span>
                        {item.label}
                        <i className="scope-note">{item.note}</i>
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            </div>

            <div className="settings-row userdata-actions">
              <label className="button file-button">
                {busy === 'import' ? '导入中…' : '导入备份'}
                <input
                  type="file"
                  accept=".zip,application/zip"
                  aria-label="导入完整备份"
                  disabled={busy !== null}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    void handleImportFile(file);
                  }}
                />
              </label>

              <details
                className="scope-menu is-right"
                open={openMenu === 'import'}
                onToggle={(event) => {
                  const isOpen = event.currentTarget.open;
                  if (isOpen) setOpenMenu('import');
                  else setOpenMenu((current) => (current === 'import' ? null : current));
                }}
              >
                <summary className="button ghost">
                  导入设置{importMode === 'replace' ? ' · 覆盖' : ' · 合并'}
                </summary>
                <div className="scope-panel">
                  {IMPORT_MODES.map((mode) => (
                    <label className="scope-item" key={mode.value}>
                      <input
                        type="radio"
                        name="import-mode"
                        checked={importMode === mode.value}
                        onChange={() => {
                          setImportMode(mode.value);
                          setOpenMenu(null);
                        }}
                      />
                      <span>
                        {mode.label}
                        <i className="scope-note">{mode.note}</i>
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            </div>

            {backupError && <p className="error">{backupError}</p>}
            {backupNotice && <p className="success small">{backupNotice}</p>}

          </section>

          {/* 第二行左：语音识别 */}
          {voice === undefined ? (
            <section className="card" data-block="voice">
              <h3>语音识别</h3>
              <p className="settings-block-sub">正在读取设置…</p>
            </section>
          ) : (
            <VoiceSettingsSection initial={voice} onSaved={(saved) => setVoice(saved)} />
          )}

          {/* 第二行右：外观主题 */}
          <ThemeSection />

        </div>

        <Dialog
          open={pendingKeyExport}
          title="这个备份包里会有明文 API Key"
          actions={[
            { label: '取消', kind: 'ghost', onClick: () => setPendingKeyExport(false) },
            { label: '继续导出', kind: 'primary', onClick: () => void acknowledgeAndExport() },
          ]}
          onDismiss={() => setPendingKeyExport(false)}
        >
          <p>你会把已配置模型的 Key 一起导出去，文件名会带 <b>KEY-</b> 前缀。</p>
          <p>
            这个 zip 相当于一份密码本：发给别人、传网盘、丢在共享文件夹里，拿到的人就能直接用你的额度。
            <b>只在自己的设备之间传才是安全的。</b>
          </p>
          <p className="settings-hint">这条提醒只会出现这一次，之后直接导出。</p>
        </Dialog>
      </div>
    </section>
  );
}
