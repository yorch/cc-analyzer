import { useState } from "react";
import { getThemePref, setThemePref, type ThemePref } from "./theme.ts";

/** Compact System / Light / Dark control for the masthead. Styled as a `.seg`
 *  segmented control (matching the cost-basis toggle) but with glyph buttons +
 *  screen-reader labels so it stays narrow beside the nav. */
const OPTIONS: readonly { pref: ThemePref; glyph: string; label: string }[] = [
  { pref: "system", glyph: "◐", label: "Match system" },
  { pref: "light", glyph: "☀", label: "Light theme" },
  { pref: "dark", glyph: "☾", label: "Dark theme" },
] as const;

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const choose = (next: ThemePref) => {
    setThemePref(next);
    setPref(next);
  };
  return (
    <fieldset className="seg theme-toggle">
      <legend className="sr-only">Color theme</legend>
      {OPTIONS.map((o) => (
        <button
          type="button"
          key={o.pref}
          className={o.pref === pref ? "active" : ""}
          onClick={() => choose(o.pref)}
          aria-pressed={o.pref === pref}
          title={o.label}
        >
          <span aria-hidden="true">{o.glyph}</span>
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </fieldset>
  );
}
