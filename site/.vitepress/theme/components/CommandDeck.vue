<script setup lang="ts">
// A scripted quick-start session. `k` tags each token for phosphor coloring:
//   c = comment, p = prompt/command, x = command continuation, o = output.
const lines: { k: "c" | "p" | "x" | "o"; t: string }[] = [
  { k: "c", t: "# 1 · install — one line; detects your platform, grabs the latest binary" },
  { k: "p", t: "curl -fsSL https://cc-analyzer.brnby.com/install.sh | sh" },
  { k: "c", t: "#   (Windows PowerShell one-liner in the install guide ▸)" },
  { k: "c", t: "" },
  { k: "c", t: "# 2 · build the index from ~/.claude, then read the totals" },
  { k: "p", t: "cc-analyzer index" },
  { k: "p", t: "cc-analyzer stats" },
  { k: "o", t: "  total spend  $1,284.57   ·   342 sessions   ·   8,912 turns" },
  { k: "c", t: "" },
  { k: "c", t: "# 3 · dig in — one session, the TUI, or the local web app" },
  { k: "p", t: "cc-analyzer analyze <session-id> --json" },
  { k: "p", t: "cc-analyzer            # interactive terminal UI" },
  { k: "p", t: "cc-analyzer serve      # http://localhost:4317" },
];
</script>

<template>
  <section class="cc-deck">
    <div class="cc-deck__grid">
      <div class="cc-deck__intro">
        <p class="cc-deck__eyebrow">// quick start</p>
        <h2 class="cc-deck__title">From zero to ledger<br />in three commands</h2>
        <p class="cc-deck__note">
          Every release ships a self-contained binary for macOS, Linux, and
          Windows — or run it from source with <code>bun</code>. The index is a
          disposable local cache; delete and rebuild it any time.
        </p>
        <a class="cc-deck__link" href="/install">
          Full install guide ▸
        </a>
      </div>

      <div class="cc-term cc-term--wide">
        <div class="cc-term__bar">
          <span class="cc-term__dots"><i /><i /><i /></span>
          <span class="cc-term__title">quick-start.sh</span>
        </div>
        <pre class="cc-term__body"><code><span
          v-for="(l, i) in lines"
          :key="i"
          class="cc-line"
          :class="l.k"
        >{{ l.t || " " }}
</span></code></pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cc-deck {
  max-width: 1152px;
  margin: 4.5rem auto 1rem;
  padding: 0 24px;
}
.cc-deck__grid {
  display: grid;
  grid-template-columns: 0.85fr 1.15fr;
  gap: clamp(2rem, 5vw, 3.5rem);
  align-items: center;
}
@media (max-width: 860px) {
  .cc-deck__grid { grid-template-columns: 1fr; }
}

.cc-deck__eyebrow {
  font-family: var(--cc-mono);
  color: var(--cc-ink-3);
  font-size: 0.82rem;
  margin: 0 0 0.8rem;
}
.cc-deck__title {
  font-family: var(--cc-display);
  font-size: clamp(1.7rem, 3.5vw, 2.4rem);
  line-height: 1.1;
  color: var(--cc-amber);
  text-shadow: 0 0 20px var(--cc-glow);
  margin: 0 0 1.1rem;
  border: 0;
  padding: 0;
}
.cc-deck__title::before { content: none; }
.cc-deck__note {
  font-family: var(--cc-mono);
  color: var(--cc-ink-2);
  font-size: 0.95rem;
  line-height: 1.7;
  margin: 0 0 1.3rem;
}
.cc-deck__note code {
  color: var(--cc-amber-hi);
  font-size: 0.9em;
}
.cc-deck__link {
  font-family: var(--cc-display);
  color: var(--cc-amber-dim);
  font-size: 0.95rem;
  transition: color 0.15s ease, text-shadow 0.15s ease;
}
.cc-deck__link:hover {
  color: var(--cc-amber-hi);
  text-shadow: 0 0 12px var(--cc-glow);
}

/* Terminal window (shares the phosphor look with the hero) */
.cc-term {
  border: 1px solid var(--cc-line-strong);
  border-radius: 10px;
  background: var(--cc-bg-1);
  box-shadow:
    0 30px 80px -34px rgba(0, 0, 0, 0.7),
    inset 0 0 90px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.cc-term__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 13px;
  background: var(--cc-bg-2);
  border-bottom: 1px solid var(--cc-line);
}
.cc-term__dots { display: inline-flex; gap: 6px; }
.cc-term__dots i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--cc-line-strong);
}
.cc-term__dots i:first-child { background: var(--cc-amber); }
.cc-term__title {
  font-family: var(--cc-mono);
  font-size: 0.74rem;
  color: var(--cc-ink-3);
}
.cc-term__body {
  margin: 0;
  padding: 18px;
  font-family: var(--cc-mono);
  font-size: 0.8rem;
  line-height: 1.7;
  overflow-x: auto;
}
.cc-line { display: block; white-space: pre; }
.cc-line.c { color: var(--cc-ink-3); }
.cc-line.o { color: var(--cc-green); }
.cc-line.p,
.cc-line.x { color: var(--cc-ink); }
/* render a phosphor prompt caret before command lines only (not continuations) */
.cc-line.p::before {
  content: "$ ";
  color: var(--cc-amber);
}
</style>
