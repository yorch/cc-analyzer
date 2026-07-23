/** Segmented control: one active option among a few short choices. */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  label = "Choose an option",
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <fieldset className="seg">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          type="button"
          key={o}
          className={o === value ? "active" : ""}
          onClick={() => onChange(o)}
          aria-pressed={o === value}
        >
          {o}
        </button>
      ))}
    </fieldset>
  );
}
