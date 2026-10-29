/**
 * 自绘下拉（2026-10-29 委托人指出：协议框是自绘的、厂商与计费方式还是系统原生，
 * 于是三个框长得不一样）。
 *
 * 为什么必须自绘：原生 `<select>` 的弹出层由浏览器/系统绘制，**没有任何 CSS 能改它**，
 * 也没法在选项上挂第二行说明。要统一外观 + 给每个选项写「选它会怎样」，只能自己画。
 *
 * 收起时只显示 `short ?? label`（省宽度），展开的列表显示全名 + 说明。
 */
import { useEffect, useId, useRef, useState } from 'react';

const MENU_OPEN_EVENT = 'ai-rec-menu-open';

export interface RecMenuOption {
  value: string;
  /** 展开列表里显示的全名 */
  label: string;
  /** 收起时显示（不给就用 label） */
  short?: string;
  /** 一行说明：这个选项是干什么的、什么时候该选它 */
  hint?: string;
}

interface RecMenuProps {
  value: string;
  options: readonly RecMenuOption[];
  ariaLabel: string;
  /** 按钮自身的 class（协议 / 厂商 / 计费方式各有宽度） */
  buttonClassName?: string;
  title?: string;
  onChange: (value: string) => void;
}

export function RecMenu({
  value,
  options,
  ariaLabel,
  buttonClassName,
  title,
  onChange,
}: RecMenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement | null>(null);
  const current = options.find((option) => option.value === value);

  /** 同一时刻只开一个菜单：弹窗里下拉挨得近，两个同时展开会互相盖住 */
  useEffect(() => {
    if (!open) return;
    const notify = new CustomEvent(MENU_OPEN_EVENT, { detail: id });
    window.dispatchEvent(notify);
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

  return (
    <span className="ai-rec-menu-wrap" ref={wrap} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className={`ai-rec-menu-btn${buttonClassName ? ` ${buttonClassName}` : ''}`}
        data-value={value}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title ?? current?.hint ?? current?.label}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="ai-rec-menu-label">{current?.short ?? current?.label ?? value}</span>
        <i className="ai-rec-caret" aria-hidden="true">
          ▾
        </i>
      </button>

      {open ? (
        <span className="ai-rec-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'is-on' : undefined}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="ai-rec-menu-item-label">{option.label}</span>
              {option.hint ? <span className="ai-rec-menu-item-hint">{option.hint}</span> : null}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
