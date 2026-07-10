<script setup lang="ts">
// The six capabilities, framed as loadable "modules". Icons are inline line-SVGs
// (kept from the prior landing page) so there are no external asset requests.
const modules = [
  {
    id: "cost",
    title: "Real cost & cache accounting",
    body: "Sessions record token counts, not cost. cc-analyzer derives it from a per-model table, pricing input, output, and cache read/write separately — where most spend hides.",
    icon: '<path d="M6 2.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 11h6M9 14h4"/>',
  },
  {
    id: "tui",
    title: "Interactive terminal UI",
    body: "Browse projects → sessions → per-turn detail in an Ink TUI with inline filtering and Summary / Turns / Transcript tabs.",
    icon: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M13 15h4"/>',
  },
  {
    id: "web",
    title: "Local web app",
    body: "cc-analyzer serve launches a Hono API and an embedded React dashboard: portfolio overview, project drill-down, and a windowed transcript reader.",
    icon: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M2.5 8.5h19"/><circle cx="5.8" cy="6.25" r=".7" fill="currentColor" stroke="none"/><circle cx="8.3" cy="6.25" r=".7" fill="currentColor" stroke="none"/>',
  },
  {
    id: "index",
    title: "Incremental SQLite index",
    body: "A disposable local index that re-parses only changed sessions (by size + mtime), then powers portfolio-wide analytics — spend by month, project, and model.",
    icon: '<ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v6c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-6"/><path d="M5 11.5v6c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-6"/>',
  },
  {
    id: "binary",
    title: "Single-binary distribution",
    body: "Ships as one self-contained executable — CLI, TUI, API, and web UI baked in — cross-compiled for macOS, Linux, and Windows.",
    icon: '<path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z"/><path d="M12 11.6v9.6M4 7.2l8 4.4 8-4.4"/>',
  },
  {
    id: "private",
    title: "Read-only & private",
    body: "Never writes to ~/.claude. Its own state (pricing cache, index) lives under ~/.config/cc-analyzer. Your session data stays on your machine.",
    icon: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>',
  },
];
</script>

<template>
  <section class="cc-mods">
    <header class="cc-mods__head">
      <span class="cc-mods__cmd">$ cc-analyzer --modules</span>
      <span class="cc-mods__meta">6 loaded · all local</span>
    </header>
    <div class="cc-mods__grid">
      <article v-for="(m, i) in modules" :key="m.id" class="cc-mod">
        <div class="cc-mod__top">
          <span class="cc-mod__idx">[{{ String(i + 1).padStart(2, "0") }}]</span>
          <span
            class="cc-mod__icon"
            aria-hidden="true"
            v-html="`<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>${m.icon}</svg>`"
          />
        </div>
        <h3 class="cc-mod__title">{{ m.title }}</h3>
        <p class="cc-mod__body">{{ m.body }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.cc-mods {
  max-width: 1152px;
  margin: 1.5rem auto 0;
  padding: 0 24px;
}
.cc-mods__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--cc-line);
  padding-bottom: 0.7rem;
  margin-bottom: 1.6rem;
  font-family: var(--cc-mono);
}
.cc-mods__cmd {
  color: var(--cc-amber);
  font-size: 0.95rem;
}
.cc-mods__meta {
  color: var(--cc-ink-3);
  font-size: 0.8rem;
}

.cc-mods__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
@media (max-width: 900px) {
  .cc-mods__grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 600px) {
  .cc-mods__grid { grid-template-columns: 1fr; }
}

.cc-mod {
  position: relative;
  border: 1px solid var(--cc-line);
  border-radius: 10px;
  background: var(--cc-panel);
  padding: 1.25rem 1.25rem 1.35rem;
  transition: border-color 0.2s ease, transform 0.15s ease, box-shadow 0.25s ease;
  overflow: hidden;
}
.cc-mod::after {
  /* faint corner glyph, like a card index tab */
  content: "▚";
  position: absolute;
  top: 0.5rem;
  right: 0.7rem;
  color: var(--cc-line);
  font-size: 0.9rem;
}
.cc-mod:hover {
  border-color: var(--cc-line-strong);
  transform: translateY(-3px);
  box-shadow: 0 16px 40px -22px var(--cc-glow);
}

.cc-mod__top {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  margin-bottom: 0.85rem;
}
.cc-mod__idx {
  font-family: var(--cc-display);
  color: var(--cc-ink-3);
  font-size: 0.82rem;
}
.cc-mod__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--cc-scan);
  border: 1px solid var(--cc-line);
  color: var(--cc-amber);
}
.cc-mod__icon :deep(svg) {
  width: 19px;
  height: 19px;
}
.cc-mod__title {
  font-family: var(--cc-display);
  font-size: 1rem;
  line-height: 1.3;
  color: var(--cc-ink);
  margin: 0 0 0.5rem;
}
.cc-mod:hover .cc-mod__title {
  color: var(--cc-amber);
}
.cc-mod__body {
  font-family: var(--cc-mono);
  font-size: 0.82rem;
  line-height: 1.6;
  color: var(--cc-ink-2);
  margin: 0;
}
</style>
