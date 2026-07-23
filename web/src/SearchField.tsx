interface SearchFieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
}

export function SearchField({
  label,
  placeholder,
  value,
  onChange,
  describedBy,
}: SearchFieldProps) {
  return (
    <label className="search-field">
      <span>{label}</span>
      <input
        className="search"
        type="search"
        name="filter"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
