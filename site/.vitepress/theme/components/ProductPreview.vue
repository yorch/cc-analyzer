<template>
  <section class="cc-preview" aria-labelledby="cc-preview-title">
    <div class="cc-preview__copy">
      <p class="cc-preview__eyebrow">// local web dashboard</p>
      <h2 id="cc-preview-title">Your session ledger, made visible</h2>
      <p>
        Launch <code>cc-analyzer serve</code> to explore portfolio totals, projects,
        trends, tools, and individual sessions in a dashboard served entirely from
        the local binary.
      </p>
      <p class="cc-preview__note">
        Preview data is synthetic. Your own prompts and transcripts never leave
        your machine.
      </p>
    </div>
    <figure class="cc-preview__frame">
      <div class="cc-preview__bar" aria-hidden="true">
        <span /><span /><span />
        <strong>localhost:4317</strong>
      </div>
      <a href="/screenshots/dashboard.webp" target="_blank" rel="noreferrer">
        <img
          src="/screenshots/dashboard.webp"
          width="1600"
          height="2327"
          loading="lazy"
          alt="cc-analyzer web dashboard showing synthetic portfolio totals, charts, and project activity"
        />
      </a>
      <figcaption>Open the full dashboard preview ↗</figcaption>
    </figure>
  </section>
</template>

<style scoped>
.cc-preview {
  max-width: 1152px;
  margin: 4.5rem auto 0;
  padding: 0 24px;
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
  gap: clamp(2rem, 5vw, 4rem);
  align-items: start;
}
.cc-preview__copy {
  position: sticky;
  top: 104px;
}
.cc-preview__eyebrow {
  margin: 0 0 0.8rem;
  color: var(--cc-ink-3);
  font: 0.82rem/1.4 var(--cc-mono);
}
.cc-preview h2 {
  margin: 0 0 1rem;
  color: var(--cc-amber);
  font: 400 clamp(1.7rem, 3.5vw, 2.4rem)/1.12 var(--cc-display);
  text-wrap: balance;
  text-shadow: 0 0 20px var(--cc-glow);
}
.cc-preview p {
  color: var(--cc-ink-2);
  font: 0.92rem/1.7 var(--cc-mono);
}
.cc-preview code {
  color: var(--cc-amber-hi);
}
.cc-preview__note {
  padding-top: 1rem;
  border-top: 1px dashed var(--cc-line);
  font-size: 0.8rem !important;
}
.cc-preview__frame {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--cc-line-strong);
  border-radius: 12px;
  background: var(--cc-bg-1);
  box-shadow: 0 28px 80px -36px rgba(0, 0, 0, 0.85);
}
.cc-preview__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 13px;
  border-bottom: 1px solid var(--cc-line);
  background: var(--cc-bg-2);
}
.cc-preview__bar span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cc-line-strong);
}
.cc-preview__bar span:first-child {
  background: var(--cc-amber);
}
.cc-preview__bar strong {
  margin-left: 6px;
  color: var(--cc-ink-3);
  font: 400 0.72rem var(--cc-mono);
}
.cc-preview__frame a {
  display: block;
  max-height: 640px;
  overflow: hidden;
  border-bottom: 1px solid var(--cc-line);
}
.cc-preview__frame img {
  display: block;
  width: 100%;
  height: auto;
  transition: transform 0.35s ease, filter 0.35s ease;
}
.cc-preview__frame a:hover img {
  transform: scale(1.012);
  filter: brightness(1.06);
}
.cc-preview figcaption {
  padding: 0.75rem 13px;
  color: var(--cc-ink-3);
  font: 0.72rem var(--cc-mono);
}
@media (max-width: 760px) {
  .cc-preview {
    grid-template-columns: minmax(0, 1fr);
  }
  .cc-preview__copy {
    position: static;
  }
  .cc-preview__frame a {
    max-height: 480px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cc-preview__frame img {
    transition: none;
  }
}
</style>
