<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{ id: string; graph: string }>();

const svg = ref("");
let observer: MutationObserver | undefined;
let renderNumber = 0;

const fontFamily =
  '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const lightThemeVariables = {
  darkMode: false,
  fontFamily,
  fontSize: "14px",
  background: "#f3ead4",
  textColor: "#3a2c14",
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

const darkThemeVariables = {
  darkMode: true,
  fontFamily,
  fontSize: "14px",
  background: "#101210",
  textColor: "#e7d6ad",
  primaryColor: "#171a13",
  primaryBorderColor: "#ffb454",
  primaryTextColor: "#e7d6ad",
  secondaryColor: "#1d2117",
  secondaryBorderColor: "#ffc978",
  secondaryTextColor: "#e7d6ad",
  tertiaryColor: "#101210",
  tertiaryBorderColor: "#a8783b",
  tertiaryTextColor: "#e7d6ad",
  lineColor: "#b09a6d",
  nodeBkg: "#171a13",
  nodeBorder: "#ffb454",
  nodeTextColor: "#e7d6ad",
  mainBkg: "#171a13",
  clusterBkg: "#101210",
  clusterBorder: "#a8783b",
  edgeLabelBackground: "#101210",
  actorBkg: "#171a13",
  actorBorder: "#ffb454",
  actorTextColor: "#e7d6ad",
  actorLineColor: "#b09a6d",
  signalColor: "#e7d6ad",
  signalTextColor: "#e7d6ad",
  labelBoxBkgColor: "#171a13",
  labelBoxBorderColor: "#ffb454",
  labelTextColor: "#e7d6ad",
  loopTextColor: "#e7d6ad",
  noteBkgColor: "#2b2417",
  noteBorderColor: "#ffc978",
  noteTextColor: "#f4e5c0",
  activationBkgColor: "#2b2417",
  activationBorderColor: "#ffc978",
};

async function renderChart() {
  const { default: mermaid } = await import("mermaid");
  const dark = document.documentElement.classList.contains("dark");
  mermaid.initialize({
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
    themeVariables: dark ? darkThemeVariables : lightThemeVariables,
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
