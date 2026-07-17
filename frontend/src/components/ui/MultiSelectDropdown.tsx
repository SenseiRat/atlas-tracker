import { useEffect, useRef, useState } from 'react';

type MultiSelectOption = { value: string; label: string };

type MultiSelectDropdownProps = {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  /** Trigger text when nothing is selected. Default "All". */
  allLabel?: string;
  /** Trigger text when there are no options at all. */
  emptyText?: string;
};

/** Compact multi-select: a select-styled trigger that opens a checkbox list. */
export function MultiSelectDropdown({
  label,
  options,
  selected,
  onToggle,
  onClear,
  allLabel = 'All',
  emptyText = 'None available',
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const summary =
    options.length === 0
      ? emptyText
      : selected.length === 0
        ? allLabel
        : selected.length === 1
          ? options.find((option) => option.value === selected[0])?.label ?? '1 selected'
          : `${selected.length} selected`;

  return (
    <div className="scope-filter multiselect" ref={rootRef}>
      {label}
      <button
        type="button"
        className="multiselect__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={options.length === 0}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="multiselect__summary">{summary}</span>
        <span className="multiselect__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && options.length > 0 && (
        <div className="multiselect__panel">
          <div className="multiselect__panel-header">
            <span>{selected.length > 0 ? `${selected.length} selected` : allLabel}</span>
            <button type="button" className="ghost-button" onClick={onClear} disabled={selected.length === 0}>
              Clear
            </button>
          </div>
          <div className="multiselect__options">
            {options.map((option) => (
              <label key={option.value} className="multiselect__option">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() => onToggle(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
