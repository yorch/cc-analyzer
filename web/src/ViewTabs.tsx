import type { ReactNode } from "react";

export function ViewTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  id,
}: {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  id: string;
}) {
  return (
    <div className="view-nav" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          type="button"
          key={item}
          id={`${id}-tab-${item}`}
          role="tab"
          aria-selected={value === item}
          aria-controls={`${id}-panel-${item}`}
          tabIndex={value === item ? 0 : -1}
          className={value === item ? "active" : ""}
          onClick={() => onChange(item)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const delta = event.key === "ArrowRight" ? 1 : -1;
            const next = items[(index + delta + items.length) % items.length] as T;
            onChange(next);
            document.getElementById(`${id}-tab-${next}`)?.focus();
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

export function ViewPanel({
  id,
  view,
  children,
}: {
  id: string;
  view: string;
  children: ReactNode;
}) {
  return (
    <div id={`${id}-panel-${view}`} role="tabpanel" aria-labelledby={`${id}-tab-${view}`}>
      {children}
    </div>
  );
}
