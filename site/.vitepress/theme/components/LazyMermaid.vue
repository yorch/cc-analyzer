<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{ id: string; graph: string }>();

const svg = ref("");
let observer: MutationObserver | undefined;
let renderNumber = 0;

const lightThemeVariables = {
  fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: "14px",
  primaryColor: "#f7efdc",
  primaryBorderColor: "#9a5f12",
  primaryTextColor: "#3a2c14",
  secondaryColor: "#efe4c9",
  secondaryBorderColor: "#8a5410",
  tertiaryColor: "#f3ead4",
  tertiaryBorderColor: "rgba(120,84,24,0.4)",
  lineColor: "#927a49",
  clusterBkg: "#f3ead4",
  clusterBorder: "rgba(120,84,24,0.4)",
  edgeLabelBackground: "#f3ead4",
};

async function renderChart() {
  const { default: mermaid } = await import("mermaid");
  const dark = document.documentElement.classList.contains("dark");
  mermaid.initialize({
    securityLevel: "strict",
    startOnLoad: false,
    theme: dark ? "dark" : "base",
    themeVariables: dark ? undefined : lightThemeVariables,
  });
  const result = await mermaid.render(
    `${props.id}-${renderNumber++}`,
    decodeURIComponent(props.graph),
  );
  svg.value = result.svg;
}

onMounted(async () => {
  await renderChart();
  observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.attributeName === "class")) {
      void renderChart();
    }
  });
  observer.observe(document.documentElement, { attributes: true });
});

onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div
    class="mermaid"
    role="img"
    aria-label="Architecture diagram"
    :aria-busy="svg ? 'false' : 'true'"
  >
    <div v-if="svg" v-html="svg" />
    <p v-else class="cc-diagram-loading" aria-live="polite">Rendering diagram…</p>
  </div>
</template>
