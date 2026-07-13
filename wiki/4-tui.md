# Interactive Terminal UI

> Indexed at commit `4d7658d` on 2026-07-13 · [view on GitHub](https://github.com/yorch/cc-analyzer/tree/4d7658d)

## Relevant source files

- [src/tui/run.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/run.tsx)
- [src/tui/App.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx)
- [src/tui/shell/AppShell.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx)
- [src/tui/shell/MasterDetail.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/MasterDetail.tsx)
- [src/tui/theme.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/theme.ts)
- [src/tui/scroll.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/scroll.ts)
- [src/tui/useTermSize.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useTermSize.ts)
- [src/tui/usePageSize.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/usePageSize.ts)
- [src/tui/useSort.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useSort.ts)
- [src/tui/components/FilterableList.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx)
- [src/tui/components/ui.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/ui.tsx)
- [src/tui/components/PortfolioLede.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/PortfolioLede.tsx)
- [src/tui/components/previews.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/previews.tsx)
- [src/tui/screens/ProjectsView.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/ProjectsView.tsx)
- [src/tui/screens/SessionListView.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionListView.tsx)
- [src/tui/screens/InsightsView.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx)
- [src/tui/screens/SessionDetailScreen.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx)

## Overview

The interactive Terminal User Interface (TUI) is an Ink (React-for-terminal) application that browses the indexed portfolio of Claude Code sessions inside a persistent, amber-phosphor master-detail shell. It launches when the Command-Line Interface (CLI) runs with no arguments, via `runTui` in [src/tui/run.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/run.tsx), which opens the SQLite index with `openDb`, loads a pricing table with `loadPricing`, and renders the `App` component through Ink's `render` ([src/tui/run.tsx#L15-L19](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/run.tsx#L15-L19)). It requires a real terminal: when either standard-input or standard-output is not a TeleTYpewriter (TTY), `runTui` prints a message pointing at the non-interactive commands and returns without rendering ([src/tui/run.tsx#L8-L14](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/run.tsx#L8-L14)).

The UI reads almost entirely from the SQLite index rather than parsing session files on the fly, so `cc-analyzer index` must run first. The `App` root pulls projects, sessions, and portfolio statistics from `../core/queries.ts` and `../core/stats.ts` ([src/tui/App.tsx#L41-L44](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L41-L44)); when the index holds no projects it renders an empty-state prompt telling the user to run the indexer and relaunch ([src/tui/App.tsx#L76-L86](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L76-L86)). The rail exposes five views — `portfolio`, `projects`, `sessions`, `insights`, and `trends` — of which only `trends` remains a placeholder marked `soon` ([src/tui/App.tsx#L30-L38](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L30-L38)). The session detail screen is the one place that parses a raw session file to build a full transcript on demand.

## Architecture

```mermaid
flowchart LR
    App[App root] --> Shell[AppShell chrome]
    Shell --> Rail[NavRail]
    Shell --> Body[body slot]
    Body --> Projects[ProjectsView]
    Body --> Sessions[SessionListView]
    Body --> Insights[InsightsView]
    App --> Detail[SessionDetailScreen]

    Projects --> MD[MasterDetail]
    Sessions --> MD
    Insights --> MD
    MD --> List[FilterableList]
    MD --> Preview[previews]

    Insights -.opens by id.-> Detail
    List -.uses.-> Sort[useSort]
    List -.uses.-> Scroll[scroll.ts]
    App -.uses.-> Term[useTermSize]
    List -.uses.-> Page[usePageSize]
```

The `App` root owns view and focus state, wraps everything in the `AppShell` chrome, and swaps the body between `ProjectsView`, `SessionListView`, and `InsightsView`. Each of those list screens composes `MasterDetail`, which pairs a `FilterableList` master with a preview detail pane. Opening a session escapes the shell entirely and mounts the full-screen `SessionDetailScreen` ([src/tui/App.tsx#L96-L109](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L96-L109)); `InsightsView` reaches that same screen by resolving a session id ([src/tui/App.tsx#L122-L125](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L122-L125)). The hooks (`useSort`, `useTermSize`, `usePageSize`) and `scroll.ts` are cross-cutting utilities the screens share.

Sources: [src/tui/App.tsx:L40-L212](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L40-L212) [src/tui/shell/AppShell.tsx:L42-L69](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx#L42-L69) [src/tui/shell/MasterDetail.tsx:L29-L60](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/MasterDetail.tsx#L29-L60)

## Module Layout

| Module | Path | Responsibility |
| ------ | ---- | -------------- |
| `runTui` | [src/tui/run.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/run.tsx) | TTY gate, database and pricing setup, Ink render entry point |
| `App` | [src/tui/App.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx) | Root: view/focus/drill state, keybindings, body routing |
| `AppShell` | [src/tui/shell/AppShell.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx) | Persistent chrome: title bar, nav rail, lede slot, key bar |
| `MasterDetail` | [src/tui/shell/MasterDetail.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/MasterDetail.tsx) | Two-pane master-detail body with responsive collapse |
| `theme` | [src/tui/theme.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/theme.ts) | Amber-phosphor palette, semantic roles, selection style, verdict colors, sparklines |
| `ProjectsView` | [src/tui/screens/ProjectsView.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/ProjectsView.tsx) | Projects master list + live project preview |
| `SessionListView` | [src/tui/screens/SessionListView.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionListView.tsx) | Sessions master list + live session preview |
| `InsightsView` | [src/tui/screens/InsightsView.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx) | Cache-efficiency hit-list: projects/sessions ranked by wasted cache-write $ |
| `SessionDetailScreen` | [src/tui/screens/SessionDetailScreen.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx) | Full-screen session view: turns, transcript, summary |
| `FilterableList` | [src/tui/components/FilterableList.tsx](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx) | Reusable scrolling list with inline substring filter |
| hooks/utils | [src/tui/useSort.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useSort.ts), [src/tui/scroll.ts](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/scroll.ts) | Column sorting, scroll-window math, responsive sizing |

Sources: [src/tui/App.tsx:L1-L38](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L1-L38) [src/tui/run.tsx:L1-L20](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/run.tsx#L1-L20)

## Key Components

### App root and navigation model

`App` holds the whole navigation state: the active `view` (one of `portfolio`, `projects`, `sessions`, `insights`, `trends`), whether input `focus` is on the `rail` or the `body`, the drilled-into `drill` project and its `drillSessions`, the `openSession`, and the `help` flag ([src/tui/App.tsx#L47-L52](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L47-L52)). The `useInput` handler only acts when focus is on the rail: arrows move between views with `moveView`, digits `1`-`5` jump directly to a view, and Enter, right-arrow, Escape, or left-arrow hand focus to the body ([src/tui/App.tsx#L60-L74](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L60-L74)). When the body has focus, the active list owns input, so the handler defers to it ([src/tui/App.tsx#L63](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L63)).

Body routing is a switch over `view`. The `portfolio` and `projects` views render `ProjectsView`, `sessions` renders `SessionListView`, and `insights` renders `InsightsView` wired to `openSessionById` so it can jump straight into a session's detail ([src/tui/App.tsx#L158-L191](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L158-L191)). Only `trends` still falls through to the `Placeholder` component, which prints a "Coming in a later phase" note; the rail entry for `trends` carries the `soon: true` flag that dims it ([src/tui/App.tsx#L37](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L37), [src/tui/App.tsx#L192-L221](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L192-L221)).

Drilling is a two-level model. From the projects list, `openProject` records the drill target and loads its sessions with `listIndexedSessions` ([src/tui/App.tsx#L113-L117](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L113-L117)); `popDrill` clears it. Opening any session sets `openSession`, which short-circuits the render to the full-screen detail screen; `openSessionById` resolves an id through `indexedSessionById` before doing the same ([src/tui/App.tsx#L96-L125](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L96-L125)).

Sources: [src/tui/App.tsx:L30-L221](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L30-L221)

### AppShell chrome

`AppShell` is the persistent frame: a `TitleBar` showing `◆ cc-analyzer` with the version and a right-aligned breadcrumb, an optional `lede` band, the nav rail beside the body, and a `KeyBar` of context hints ([src/tui/shell/AppShell.tsx#L54-L68](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx#L54-L68)). The whole shell is pinned to `rows - 2` with `overflow="hidden"`, and the body between the lede and key bar flex-grows and clips overflow, so the title and key bar stay on screen and the frame never grows taller than the viewport ([src/tui/shell/AppShell.tsx#L32-L55](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx#L32-L55)). The `NavRail` renders each entry's icon and label, painting the active view with an inverse amber bar and a `❯` marker when the rail is focused, and dimming any entry flagged `soon` ([src/tui/shell/AppShell.tsx#L82-L118](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx#L82-L118)). The `KeyBar` always appends `? help · ctrl-c quit` ([src/tui/shell/AppShell.tsx#L121-L128](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx#L121-L128)).

Sources: [src/tui/shell/AppShell.tsx:L1-L129](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/AppShell.tsx#L1-L129)

### MasterDetail pane pattern

`MasterDetail` is the two-pane body used by all three list screens: a fixed-width master pane on the left drives a flex-growing detail pane on the right ([src/tui/shell/MasterDetail.tsx#L39-L59](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/MasterDetail.tsx#L39-L59)). The `masterWidth` helper computes the master pane's column width — 40% of terminal columns by default, floored at 22 — so list rows can truncate their content to fit rather than wrap ([src/tui/shell/MasterDetail.tsx#L16-L22](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/MasterDetail.tsx#L16-L22)). On narrow terminals the detail pane is dropped and only the master renders, matching the pre-shell single-column stack ([src/tui/shell/MasterDetail.tsx#L36-L38](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/MasterDetail.tsx#L36-L38)).

Sources: [src/tui/shell/MasterDetail.tsx:L1-L60](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/shell/MasterDetail.tsx#L1-L60)

### FilterableList and previews

`FilterableList` is the reusable master widget. Printable keys build an inline substring `query`, arrows move the `cursor`, Enter selects, backspace edits the query, and Escape clears the query or calls `onBack` when it is already empty ([src/tui/components/FilterableList.tsx#L69-L108](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx#L69-L108)). Vim `j`/`k` are deliberately not bound so those letters can be typed into the filter ([src/tui/components/FilterableList.tsx#L28-L33](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx#L28-L33)). As the cursor or filter moves, the list fires `onHighlight` with the current item so the parent can update the live detail preview ([src/tui/components/FilterableList.tsx#L57-L62](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx#L57-L62)). The header shows the filter query, a `filtered/total` count, and the current sort label ([src/tui/components/FilterableList.tsx#L111-L129](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx#L111-L129)).

The `previews` module renders the detail pane. `ProjectPreview` shows a selected project's spend, session count, tokens, cache share, and last-active time ([src/tui/components/previews.tsx#L29-L60](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/previews.tsx#L29-L60)), and `SessionPreview` shows a session's cost, tokens, turns, call and tool counts, and timestamps ([src/tui/components/previews.tsx#L62-L111](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/previews.tsx#L62-L111)). `CachePreview` is the insights detail pane, covered below. The shared `ui.tsx` supplies `Footer`, `Loading`, `Empty`, `ScrollRange`, and the modal `HelpOverlay` cheatsheet that lists every keybinding and closes on any key ([src/tui/components/ui.tsx#L79-L105](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/ui.tsx#L79-L105)).

Sources: [src/tui/components/FilterableList.tsx:L1-L145](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx#L1-L145) [src/tui/components/previews.tsx:L1-L162](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/previews.tsx#L1-L162) [src/tui/components/ui.tsx:L1-L105](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/ui.tsx#L1-L105)

### List screens and PortfolioLede

`ProjectsView` and `SessionListView` are thin adapters that wrap a `FilterableList` master and a preview detail inside `MasterDetail`. Each defines its own `SORT_FIELDS` — projects sort by recent, cost, tokens, sessions, or name ([src/tui/screens/ProjectsView.tsx#L11-L17](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/ProjectsView.tsx#L11-L17)); sessions by recent, cost, tokens, or title ([src/tui/screens/SessionListView.tsx#L11-L16](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionListView.tsx#L11-L16)) — and pipe the sorted rows into the list while tracking the highlighted item for the preview ([src/tui/screens/ProjectsView.tsx#L29-L61](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/ProjectsView.tsx#L29-L61)). `SessionListView` is generic and shared by both the all-sessions rail view and a project's drilled-in list, with a `showProject` flag adding the owning project to the searchable filter text ([src/tui/screens/SessionListView.tsx#L31-L63](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionListView.tsx#L31-L63)). `PortfolioLede` is the full-width band under the title bar on the portfolio view: total spend, tokens, session and project counts, date range, estimated share, and a per-month spend sparkline ([src/tui/components/PortfolioLede.tsx#L8-L40](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/PortfolioLede.tsx#L8-L40)).

Sources: [src/tui/screens/ProjectsView.tsx:L1-L62](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/ProjectsView.tsx#L1-L62) [src/tui/screens/SessionListView.tsx:L1-L78](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionListView.tsx#L1-L78) [src/tui/components/PortfolioLede.tsx:L1-L40](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/PortfolioLede.tsx#L1-L40)

### InsightsView cache hit-list

`InsightsView` is a self-contained cache-efficiency hit-list that ranks where spend is being wasted on cache writes that never amortize. It pulls three memoized selectors from `../../core/stats.ts` — `cacheSummary` for the portfolio totals, `cacheWasteByProject` for the project ranking, and `cacheWasteBySession` for a drilled-in project's sessions ([src/tui/screens/InsightsView.tsx#L49-L56](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L49-L56)). A one-line header sits above every level, reading `cache: $X written · $Y un-amortized · Z% of spend`, where the percentage is the wasted cache-write cost over total cost ([src/tui/screens/InsightsView.tsx#L59-L67](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L59-L67)).

The view is a two-level drill, like the session detail screen, so `App` only routes to it. The top level lists projects sorted by wasted cache-write dollars (falling back to read:write ratio, write cost, or name), and selecting one sets `drilled` and re-renders the same list at session granularity ([src/tui/screens/InsightsView.tsx#L20-L31](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L20-L31), [src/tui/screens/InsightsView.tsx#L103-L120](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L103-L120)). At the session level, Enter calls `onOpenSession` with the session id, which `App` resolves into the full detail screen; Escape from the session level clears `drilled`, and Escape from the project level calls `onBack` to refocus the rail ([src/tui/screens/InsightsView.tsx#L69-L90](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L69-L90)). When the index holds no cache activity, the project list is replaced with a "No cache activity" note ([src/tui/screens/InsightsView.tsx#L92-L101](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L92-L101)).

Both drill levels share the internal `CacheHitList`, a generic over `CacheMetrics` that composes a sorted `FilterableList` master with a `CachePreview` detail pane inside `MasterDetail` ([src/tui/screens/InsightsView.tsx#L124-L188](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L124-L188)). Each row prints the waste dollars, the read:write ratio, a colored verdict dot, and a truncated label; the dot's color comes from `VERDICT_COLOR[cacheVerdict(r.ratio)]`, mapping the ratio to `efficient`, `ok`, or `leaky` ([src/tui/screens/InsightsView.tsx#L169-L176](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L169-L176)). `CachePreview` renders the highlighted row's verdict badge (`● efficient/ok/leaky` plus the ratio), its un-amortized waste, and a cost composition breaking cache-write, cache-read, input, and output into dollars and percentage of the row's total ([src/tui/components/previews.tsx#L113-L162](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/previews.tsx#L113-L162)).

Sources: [src/tui/screens/InsightsView.tsx:L1-L188](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/InsightsView.tsx#L1-L188) [src/tui/components/previews.tsx:L113-L162](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/previews.tsx#L113-L162) [src/tui/theme.ts:L117-L122](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/theme.ts#L117-L122)

### SessionDetailScreen

Opening a session mounts `SessionDetailScreen` full-screen. It parses the raw session file with `parseSessionFile`, runs `analyzeSession`, and builds a transcript with `buildTranscript` in an effect, showing a `Loading` line until the data arrives ([src/tui/screens/SessionDetailScreen.tsx#L44-L71](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx#L44-L71)). It has three modes — `turns`, `transcript`, `summary` — switched with `t`/`s`/`u` or digits `1`-`3`, with Escape returning to `turns` from the other modes ([src/tui/screens/SessionDetailScreen.tsx#L59-L69](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx#L59-L69)). The `TurnsPane` is itself a master-detail: a turns list drives a steps detail, toggling between the `turns` and `steps` panes with right/left arrows, Tab, or Enter, mirroring the shell's rail-body model ([src/tui/screens/SessionDetailScreen.tsx#L144-L277](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx#L144-L277)). Individual steps expand in place via `StepRow`, showing per-step input and result detail with a chevron and status marks ([src/tui/screens/SessionDetailScreen.tsx#L279-L324](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx#L279-L324)).

Sources: [src/tui/screens/SessionDetailScreen.tsx:L40-L324](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx#L40-L324)

### Theme, sizing, sorting, and scrolling

`theme.ts` is the single source of the amber-phosphor design system: a `palette` of hex colors, intent-named `role` aliases (`heading`, `cost`, `body`, `muted`), a `selection` style that paints selected rows amber-inverse, and helpers for sparklines and bars ([src/tui/theme.ts#L20-L85](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/theme.ts#L20-L85)). It also exposes `VERDICT_COLOR`, mapping the cache-efficiency verdict to green/amber/red, and maps step and transcript kinds to icons and colors ([src/tui/theme.ts#L87-L131](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/theme.ts#L87-L131)). `useTermSize` tracks live terminal dimensions, updating on resize and falling back to 80×24 ([src/tui/useTermSize.ts#L10-L27](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useTermSize.ts#L10-L27)), and its `layoutMode` classifies width into `full`, `compact`, or `narrow` to drive the responsive rail and pane collapse ([src/tui/useTermSize.ts#L29-L41](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useTermSize.ts#L29-L41)). `usePageSize` derives how many list rows fit from terminal height minus reserved chrome ([src/tui/usePageSize.ts#L9-L13](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/usePageSize.ts#L9-L13)). `useSort` cycles sort fields on Tab and flips direction on Shift-Tab, defaulting to descending ([src/tui/useSort.ts#L30-L42](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useSort.ts#L30-L42)). `scrollOffset` keeps the cursor inside the visible window so every scrollable pane scrolls identically ([src/tui/scroll.ts#L7-L11](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/scroll.ts#L7-L11)).

Sources: [src/tui/theme.ts:L20-L131](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/theme.ts#L20-L131) [src/tui/useTermSize.ts:L10-L41](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useTermSize.ts#L10-L41) [src/tui/usePageSize.ts:L9-L13](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/usePageSize.ts#L9-L13) [src/tui/useSort.ts:L30-L42](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/useSort.ts#L30-L42) [src/tui/scroll.ts:L7-L11](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/scroll.ts#L7-L11)

## Input Handling & Keybindings

Input is layered by focus. The `App` root only reacts to keys while the rail is focused; otherwise the active body view's own `useInput` owns the keyboard, and the root handler stays inert except for the global `?` help toggle ([src/tui/App.tsx#L60-L74](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L60-L74)). Escape from a list refocuses the rail, and from the rail, Enter or the right arrow pushes focus back into the body, so navigation and browsing never fight over the same keys. The key hints shown in the `KeyBar` change with context — rail focus, a drilled-in list, the `trends` placeholder, or a normal list all print different guidance ([src/tui/App.tsx#L137-L144](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L137-L144)). The full cheatsheet lives in the modal `HelpOverlay`, grouped into Global, Navigation, Lists, and Session detail sections ([src/tui/components/ui.tsx#L43-L77](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/ui.tsx#L43-L77)).

Within lists, `FilterableList` interprets printable keys as filter input rather than navigation, which is why the arrows (not `j`/`k`) move the cursor and Tab/Shift-Tab drive sorting ([src/tui/components/FilterableList.tsx#L69-L108](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx#L69-L108)). The session detail screen inverts this: it binds `j`/`k` alongside the arrows and adds `g`/`G` jumps and Enter/Space expansion, since it has no free-text filter ([src/tui/screens/SessionDetailScreen.tsx#L186-L208](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx#L186-L208)).

| Key | Context | Action |
| --- | ------- | ------ |
| `?` | anywhere | Toggle the help overlay |
| `ctrl-c` | anywhere | Quit |
| `↑` / `↓` | rail focused | Switch view |
| `1`-`5` | rail focused | Jump directly to a view |
| `↵` / `→` | rail focused | Focus the list body |
| `esc` | list | Clear the filter, or refocus the rail when empty |
| type | list | Build the substring filter query |
| `tab` / `shift-tab` | list | Cycle sort field / flip direction |
| `↑` / `↓` | list | Move cursor and update the live preview |
| `↵` | list | Open or drill into the highlighted row |
| `1`-`3` / `t` `s` `u` | session detail | Switch turns / transcript / summary mode |
| `→` / `tab` | session detail turns | Focus the steps pane |
| `←` / `shift-tab` / `esc` | session detail steps | Return to the turns pane |
| `↑` / `↓` / `j` / `k` | session detail | Move the cursor |
| `g` / `G` | session detail | Jump to top / bottom |
| `↵` / space | session detail | Expand or collapse the selected row |

Sources: [src/tui/App.tsx:L60-L144](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/App.tsx#L60-L144) [src/tui/components/FilterableList.tsx:L69-L108](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/FilterableList.tsx#L69-L108) [src/tui/components/ui.tsx:L43-L105](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/components/ui.tsx#L43-L105) [src/tui/screens/SessionDetailScreen.tsx:L59-L208](https://github.com/yorch/cc-analyzer/blob/4d7658d/src/tui/screens/SessionDetailScreen.tsx#L59-L208)

## Related Pages

- [Core Analysis Engine](./2-core-analysis-engine.md)
- [Command-Line Interface](./3-cli.md)
- [Web Server and API](./5-web-server-and-api.md)
- [Web SPA Frontend](./6-web-spa-frontend.md)
