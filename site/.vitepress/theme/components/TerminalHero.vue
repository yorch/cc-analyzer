<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";

const installCommand = "curl -fsSL https://cc-analyzer.brnby.com/install.sh | sh";
const copyState = ref<"idle" | "copied" | "failed">("idle");

async function copyInstallCommand() {
  try {
    await navigator.clipboard.writeText(installCommand);
    copyState.value = "copied";
  } catch {
    copyState.value = "failed";
  }
}

// Sample ledger output rendered line-by-line as a fake boot sequence. Each line
// carries an index used to stagger its reveal via CSS custom property --i.
const boot: { t: string; cls?: string }[] = [
  { t: "$ cc-analyzer stats", cls: "cmd" },
  { t: "◆ cc-analyzer · portfolio", cls: "dim" },
  { t: "$21.45 total spend  · 18 sessions · 4 projects", cls: "row" },
  { t: "308.9k +28.7M cache · 1h 21m active", cls: "ok" },
  { t: "", cls: "dim" },
  { t: "▸ Activity", cls: "dim" },
  { t: "metric               value", cls: "rule" },
  { t: "-------------------  ----------------------", cls: "rule" },
  { t: "pricing              exact", cls: "row" },
  { t: "tokens (in/out)      188.6k / 120.3k", cls: "row" },
];
</script>

<template>
  <section class="cc-hero">
    <div class="cc-hero__grid">
      <!-- Left: wordmark, tagline, CTAs -->
      <div class="cc-hero__intro">
        <p class="cc-hero__eyebrow">// read-only · local · single binary</p>
        <h1 class="cc-hero__mark">cc&#8209;analyzer<span class="cc-caret">_</span></h1>
        <p class="cc-hero__tag">
          Point it at the JSONL transcripts already sitting in
          <code>~/.claude</code> and it reconstructs the ledger your Claude Code
          sessions never wrote down — <strong>cost, tokens, cache accounting,
          tools, skills, models,</strong> and a per-turn breakdown.
        </p>
        <div class="cc-hero__actions">
          <a class="cc-btn cc-btn--brand" :href="withBase('/install')">
            Install <span aria-hidden="true">▸</span>
          </a>
          <a
            class="cc-btn cc-btn--ghost"
            href="https://github.com/yorch/cc-analyzer"
            target="_blank"
            rel="noreferrer"
          >
            View source
          </a>
        </div>
        <div class="cc-install">
          <div class="cc-install__command">
            <code><span class="cc-key">$</span> {{ installCommand }}</code>
            <button
              class="cc-install__copy"
              type="button"
              :aria-label="copyState === 'copied' ? 'Install command copied' : 'Copy install command'"
              @click="copyInstallCommand"
            >
              {{ copyState === "copied" ? "copied ✓" : copyState === "failed" ? "copy failed" : "copy" }}
            </button>
          </div>
          <p class="cc-install__meta">
            macOS / Linux · detects platform · verifies SHA-256 ·
            <a :href="withBase('/install')">review installer</a>
          </p>
          <span class="sr-only" aria-live="polite">
            {{
              copyState === "copied"
                ? "Install command copied to clipboard."
                : copyState === "failed"
                  ? "Could not copy the install command."
                  : ""
            }}
          </span>
        </div>
      </div>

      <!-- Right: animated terminal window -->
      <div class="cc-term" role="img" aria-label="Sample cc-analyzer stats output">
        <div class="cc-term__bar">
          <span class="cc-term__dots"><i /><i /><i /></span>
          <span class="cc-term__title">session-ledger — zsh — 80×24</span>
        </div>
        <pre class="cc-term__body"><code><span
          v-for="(line, i) in boot"
          :key="i"
          class="cc-line"
          :class="line.cls"
          :style="{ '--i': i }"
        >{{ line.t }}
</span><span class="cc-line cc-prompt" :style="{ '--i': boot.length }">$ <span class="cc-caret">▋</span></span></code></pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cc-hero {
  max-width: 1152px;
  margin: 0 auto;
  padding: clamp(2.5rem, 6vw, 5.5rem) 24px 2rem;
}
.cc-hero__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: clamp(2rem, 5vw, 4rem);
  align-items: center;
}
.cc-hero__intro,
.cc-term {
  min-width: 0;
}

/* ---- Intro column -------------------------------------------------------- */
.cc-hero__eyebrow {
  font-family: var(--cc-mono);
  color: var(--cc-ink-3);
  font-size: 0.82rem;
  letter-spacing: 0.02em;
  margin: 0 0 1rem;
}
.cc-hero__mark {
  font-family: var(--cc-display);
  font-size: clamp(2.6rem, 6.5vw, 4.4rem);
  line-height: 0.98;
  color: var(--cc-amber);
  margin: 0 0 1.2rem;
  text-shadow: 0 0 26px var(--cc-glow);
  word-break: keep-all;
}
.cc-hero__tag {
  font-family: var(--cc-mono);
  color: var(--cc-ink-2);
  font-size: 1.02rem;
  line-height: 1.7;
  max-width: 34rem;
  margin: 0 0 2rem;
}
.cc-hero__tag code {
  color: var(--cc-amber-hi);
  font-size: 0.9em;
}
.cc-hero__tag strong {
  color: var(--cc-ink);
  font-weight: 600;
}

.cc-hero__actions {
  display: flex;
  gap: 0.9rem;
  flex-wrap: wrap;
  margin-bottom: 1.6rem;
}
.cc-btn {
  font-family: var(--cc-display);
  font-size: 0.95rem;
  padding: 0.72rem 1.35rem;
  border-radius: 7px;
  border: 1px solid transparent;
  transition: transform 0.12s ease, box-shadow 0.2s ease, background 0.2s ease;
  white-space: nowrap;
}
.cc-btn--brand {
  background: var(--cc-amber);
  color: #14100a;
  box-shadow: 0 0 0 rgba(255, 165, 60, 0);
}
.cc-btn--brand:hover {
  background: var(--cc-amber-hi);
  box-shadow: 0 6px 30px var(--cc-glow);
  transform: translateY(-1px);
}
.cc-btn--ghost {
  border-color: var(--cc-line-strong);
  color: var(--cc-ink);
}
.cc-btn--ghost:hover {
  border-color: var(--cc-amber);
  color: var(--cc-amber);
  text-shadow: 0 0 12px var(--cc-glow);
}

.cc-install {
  font-family: var(--cc-mono);
  border-top: 1px dashed var(--cc-line);
  padding-top: 1rem;
}
.cc-install__command {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  color: var(--cc-ink-2);
}
.cc-install__command code {
  flex: 1;
  min-width: 0;
  font-family: inherit;
  font-size: 0.78rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.cc-install__copy {
  flex: 0 0 auto;
  padding: 0.2rem 0.48rem;
  border: 1px solid var(--cc-line-strong);
  border-radius: 4px;
  background: var(--cc-bg-2);
  color: var(--cc-ink-2);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}
.cc-install__copy:hover {
  border-color: var(--cc-amber);
  color: var(--cc-amber-hi);
}
.cc-install__meta {
  margin: 0.45rem 0 0;
  color: var(--cc-ink-3);
  font-size: 0.7rem;
  line-height: 1.5;
}
.cc-install__meta a {
  color: var(--cc-ink-2);
  text-decoration: underline;
  text-decoration-color: var(--cc-line-strong);
  text-underline-offset: 0.18em;
}
.cc-install__meta a:hover {
  color: var(--cc-amber);
}
.cc-install__copy:focus-visible,
.cc-install__meta a:focus-visible {
  outline: 2px solid var(--cc-amber);
  outline-offset: 3px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.cc-key {
  color: var(--cc-amber);
}

/* ---- Terminal window ----------------------------------------------------- */
.cc-term {
  border: 1px solid var(--cc-line-strong);
  border-radius: 10px;
  background: var(--cc-bg-1);
  box-shadow:
    0 30px 80px -30px rgba(0, 0, 0, 0.7),
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
.cc-term__dots {
  display: inline-flex;
  gap: 6px;
}
.cc-term__dots i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--cc-line-strong);
}
.cc-term__dots i:first-child {
  background: var(--cc-amber);
}
.cc-term__title {
  font-family: var(--cc-mono);
  font-size: 0.74rem;
  color: var(--cc-ink-3);
}
.cc-term__body {
  margin: 0;
  padding: 18px 18px 20px;
  font-family: var(--cc-mono);
  font-size: 0.82rem;
  line-height: 1.65;
  color: var(--cc-ink);
  overflow-x: auto;
}
.cc-line {
  display: block;
  white-space: pre;
}
.cc-line.cmd { color: var(--cc-amber-hi); }
.cc-line.dim { color: var(--cc-ink-3); }
.cc-line.rule { color: var(--cc-line-strong); }
.cc-line.row { color: var(--cc-ink); }
.cc-line.ok { color: var(--cc-green); }
.cc-prompt { color: var(--cc-amber); }

.cc-caret {
  color: var(--cc-amber);
  animation: cc-blink 1.1s steps(1) infinite;
}
@keyframes cc-blink {
  0%, 55% { opacity: 1; }
  56%, 100% { opacity: 0.12; }
}

/* Boot reveal: each line fades/rises in sequence. */
@media (prefers-reduced-motion: no-preference) {
  .cc-line {
    opacity: 0;
    transform: translateY(4px);
    animation: cc-typein 0.34s ease forwards;
    animation-delay: calc(var(--i) * 0.16s + 0.2s);
  }
  @keyframes cc-typein {
    to { opacity: 1; transform: none; }
  }
  .cc-hero__intro > * {
    opacity: 0;
    animation: cc-rise 0.6s ease forwards;
  }
  .cc-hero__eyebrow { animation-delay: 0.05s; }
  .cc-hero__mark { animation-delay: 0.14s; }
  .cc-hero__tag { animation-delay: 0.24s; }
  .cc-hero__actions { animation-delay: 0.34s; }
  .cc-install { animation-delay: 0.44s; }
  @keyframes cc-rise {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }
}

/* ---- Responsive ---------------------------------------------------------- */
@media (max-width: 860px) {
  .cc-hero__grid {
    grid-template-columns: 1fr;
  }
  .cc-term {
    order: 2;
  }
}
@media (max-width: 520px) {
  .cc-hero__mark {
    font-size: clamp(2rem, 11vw, 2.8rem);
  }
  .cc-term__body {
    font-size: 0.72rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cc-caret {
    animation: none;
  }
}
</style>
