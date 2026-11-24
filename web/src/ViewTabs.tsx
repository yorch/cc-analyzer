import type { ReactNode } from "react";

export function ViewTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  id,
  className = "view-nav",
}: {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  id: string;
  /** Visual variant: `view-nav` (default) or the session page's `tabs`. */
  className?: string;
}) {
  return (
    <div className={className} role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          type="button"
          key={item}
          id={`${id}-tab-${item}`}
          role="tab"
          aria-selected={value === item}
          // Only the active panel is mounted, so only it can be referenced.
          aria-controls={value === item ? `${id}-panel-${item}` : undefined}
          tabIndex={value === item ? 0 : -1}
          className={value === item ? "active" : ""}
          onClick={() => onChange(item)}
          onKeyDown={(event) => {
            let nextIndex: number;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % items.length;
            else if (event.key === "ArrowLeft")
              nextIndex = (index - 1 + items.length) % items.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = items.length - 1;
            else return;
            event.preventDefault();
            const next = items[nextIndex] as T;
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
