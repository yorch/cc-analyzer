import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import CommandDeck from "./components/CommandDeck.vue";
import LazyMermaid from "./components/LazyMermaid.vue";
import ProductPreview from "./components/ProductPreview.vue";
import TerminalHero from "./components/TerminalHero.vue";
import TerminalModules from "./components/TerminalModules.vue";
import TuiPreview from "./components/TuiPreview.vue";
import Layout from "./Layout.vue";

import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-400-italic.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("TerminalHero", TerminalHero);
    app.component("TerminalModules", TerminalModules);
    app.component("CommandDeck", CommandDeck);
    app.component("ProductPreview", ProductPreview);
    app.component("TuiPreview", TuiPreview);
    app.component("LazyMermaid", LazyMermaid);
  },
} satisfies Theme;
