import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import CommandDeck from "./components/CommandDeck.vue";
import TerminalHero from "./components/TerminalHero.vue";
import TerminalModules from "./components/TerminalModules.vue";
import Layout from "./Layout.vue";

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("TerminalHero", TerminalHero);
    app.component("TerminalModules", TerminalModules);
    app.component("CommandDeck", CommandDeck);
  },
} satisfies Theme;
