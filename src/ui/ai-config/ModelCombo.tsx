/**
 * 模型选择：可自由输入的 Combobox（自绘，样式与协议/厂商/计费方式一致）。
 *
 * 为什么不用原生 `<select>`：
 * - 原生下拉的弹层由系统绘制，**没有任何 CSS 能改**，会出现系统蓝底高亮；
 * - 原生 select 只能选列表里的项，**用户没法填预设表里没有的模型**。
 *
 * 行为：
 * - 输入框可以直接打字 → 任意 model id（中转站自造的名字也能用）；
 * - 聚焦/点箭头 → 展开候选（预设 + 从站上拉回来的）；
 * - 输入时按候选过滤，回车收起。
 */
import { useEffect, useId, useRef, useState } from 'react';

const MENU_OPEN_EVENT = 'ai-rec-menu-open';

interface Props {
  value: string;
  candidates: readonly string[];
  ariaLabel: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

export function ModelCombo({ value, candidates, ariaLabel, placeholder, onChange }: Props) {
  const [open, setOpen] = useState(false);
  /** 过滤关键词：只在用户打字时生效；展开时清空，让候选列表完整 */
  const [query, setQuery] = useState('');
  const id = useId();
  const wrap = useRef<HTMLSpanElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  // 同一时刻只开一个弹层（和 RecMenu 共用事件，避免两个菜单叠在一起）
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: id }));
    const onOther = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    window.addEventListener(MENU_OPEN_EVENT, onOther);
    return () => window.removeEventListener(MENU_OPEN_EVENT, onOther);
  }, [open, id]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visible = candidates.filter((item) => (needle === '' ? true : item.toLowerCase().includes(needle)));
  // 输入了列表里没有的名字：给一条「就用这个」，避免让人以为不能用
  const exact = candidates.some((item) => item.toLowerCase() === needle);
  const showCustom = needle !== '' && !exact;

  return (
    <span className="ai-rec-menu-wrap ai-rec-combo" ref={wrap} data-open={open ? 'true' : undefined}>
      <input
        ref={input}
        type="text"
        className="ai-rec-model"
        aria-label={ariaLabel}
        aria-expanded={open}
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder ?? '选一个，或直接填模型 id'}
        onChange={(event) => {
          onChange(event.target.value);
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      <button
        type="button"
        className="ai-rec-caret-btn"
        aria-label={`展开候选 ${ariaLabel}`}
        tabIndex={-1}
        onClick={() => {
          setQuery('');
          setOpen((was) => !was);
          input.current?.focus();
        }}
      >
        ▾
      </button>

      {open ? (
        <span className="ai-rec-menu" role="listbox" aria-label={ariaLabel}>
          {showCustom ? (
            <button type="button" role="option" aria-selected={false} onClick={() => setOpen(false)}>
              <span className="ai-rec-menu-item-label">就用「{value.trim()}」</span>
              <span className="ai-rec-menu-item-hint">预设表里没有也能用，能力到 AI 配置页勾</span>
            </button>
          ) : null}
          {visible.length === 0 && !showCustom ? (
            <span className="ai-rec-menu-empty">没有候选，直接输入模型 id 即可</span>
          ) : (
            visible.map((item) => (
              <button
                key={item}
                type="button"
                role="option"
                aria-selected={item.toLowerCase() === needle}
                className={item.toLowerCase() === needle ? 'is-on' : undefined}
                onClick={() => {
                  onChange(item);
                  setOpen(false);
                }}
              >
                <span className="ai-rec-menu-item-label">{item}</span>
              </button>
            ))
          )}
        </span>
      ) : null}
    </span>
  );
}
