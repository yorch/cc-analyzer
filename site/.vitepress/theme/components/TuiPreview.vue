<template>
  <section class="cc-tui-preview" aria-labelledby="cc-tui-preview-title">
    <header class="cc-tui-preview__head">
      <div>
        <p class="cc-tui-preview__eyebrow">// interactive terminal UI</p>
        <h2 id="cc-tui-preview-title">The real TUI, frame for frame</h2>
      </div>
      <p>
        Generated from the Ink application against the same synthetic fixture as
        the dashboard. Portfolio and Trends are shown here at 100×24.
      </p>
    </header>
    <div class="cc-tui-preview__grid">
      <figure>
        <a href="/screenshots/tui-portfolio.svg" target="_blank" rel="noreferrer">
          <img
            src="/screenshots/tui-portfolio.svg"
            width="884"
            height="484"
            loading="lazy"
            alt="cc-analyzer TUI portfolio screen generated from the real Ink application"
          />
        </a>
        <figcaption><span>01</span> Portfolio — totals, projects, and live preview</figcaption>
      </figure>
      <figure>
        <a href="/screenshots/tui-trends.svg" target="_blank" rel="noreferrer">
          <img
            src="/screenshots/tui-trends.svg"
            width="884"
            height="484"
            loading="lazy"
            alt="cc-analyzer TUI trends screen generated from the real Ink application"
          />
        </a>
        <figcaption><span>02</span> Trends — burn chart and activity heatmap</figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.cc-tui-preview {
  max-width: 1152px;
  margin: 4.5rem auto 0;
  padding: 0 24px;
}
.cc-tui-preview__head {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: clamp(1.5rem, 5vw, 4rem);
  align-items: end;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--cc-line);
}
.cc-tui-preview__eyebrow {
  margin: 0 0 0.75rem;
  color: var(--cc-ink-3);
  font: 0.82rem/1.4 var(--cc-mono);
}
.cc-tui-preview h2 {
  margin: 0;
  color: var(--cc-amber);
  font: 400 clamp(1.7rem, 3.5vw, 2.4rem)/1.12 var(--cc-display);
  text-wrap: balance;
  text-shadow: 0 0 20px var(--cc-glow);
}
.cc-tui-preview__head > p {
  margin: 0;
  color: var(--cc-ink-2);
  font: 0.9rem/1.7 var(--cc-mono);
}
.cc-tui-preview__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}
.cc-tui-preview figure {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--cc-line-strong);
  border-radius: 12px;
  background: var(--cc-bg-1);
  box-shadow: 0 24px 60px -36px rgba(0, 0, 0, 0.9);
}
.cc-tui-preview a {
  display: block;
  overflow: hidden;
  border-bottom: 1px solid var(--cc-line);
}
.cc-tui-preview img {
  display: block;
  width: 100%;
  height: auto;
  transition: transform 0.25s ease, filter 0.25s ease;
}
.cc-tui-preview a:hover img {
  transform: scale(1.01);
  filter: brightness(1.08);
}
.cc-tui-preview figcaption {
  padding: 0.75rem 13px;
  color: var(--cc-ink-3);
  font: 0.72rem/1.4 var(--cc-mono);
}
.cc-tui-preview figcaption span {
  margin-right: 0.65rem;
  color: var(--cc-amber);
}
@media (max-width: 760px) {
  .cc-tui-preview__head,
  .cc-tui-preview__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cc-tui-preview img {
    transition: none;
  }
}
</style>
