import { describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { AppShell, type NavEntry } from "../../src/tui/shell/AppShell.tsx";
import { MasterDetail } from "../../src/tui/shell/MasterDetail.tsx";
import { layoutMode } from "../../src/tui/useTermSize.ts";

const ENTRIES: NavEntry[] = [
  { key: "portfolio", label: "portfolio", icon: "▤" },
  { key: "projects", label: "projects", icon: "▸" },
  { key: "trends", label: "trends", icon: "∿", soon: true },
];

describe("layoutMode", () => {
  test("boundaries", () => {
    expect(layoutMode(120)).toBe("full");
    expect(layoutMode(100)).toBe("full");
    expect(layoutMode(99)).toBe("compact");
    expect(layoutMode(90)).toBe("compact");
    expect(layoutMode(89)).toBe("narrow");
    expect(layoutMode(60)).toBe("narrow");
  });
});

describe("MasterDetail", () => {
  test("shows both panes when wide", () => {
    const { lastFrame } = render(
      <MasterDetail columns={120} master={<Text>MASTER</Text>} detail={<Text>DETAIL</Text>} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MASTER");
    expect(frame).toContain("DETAIL");
  });

  test("collapses to master only when narrow", () => {
    const { lastFrame } = render(
      <MasterDetail columns={70} master={<Text>MASTER</Text>} detail={<Text>DETAIL</Text>} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MASTER");
    expect(frame).not.toContain("DETAIL");
  });
});

describe("AppShell", () => {
  test("renders chrome: title, breadcrumb, rail labels, key bar", () => {
    const { lastFrame } = render(
      <AppShell
        breadcrumb="portfolio ▸ projects"
        entries={ENTRIES}
        active="projects"
        keyHints="↑↓ move"
        columns={120}
        rows={40}
      >
        <Text>BODY</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cc-analyzer");
    expect(frame).toContain("portfolio ▸ projects");
    expect(frame).toContain("projects"); // rail label
    expect(frame).toContain("BODY");
    expect(frame).toContain("? help"); // key bar suffix
  });

  test("pins to the viewport height and clips a too-tall body", () => {
    const tall = Array.from({ length: 60 }, (_, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static synthetic rows
      <Text key={i}>row-{i}</Text>
    ));
    const { lastFrame } = render(
      <AppShell
        breadcrumb="portfolio"
        entries={ENTRIES}
        active="portfolio"
        keyHints="↑↓ move"
        columns={120}
        rows={10}
      >
        <Box flexDirection="column">{tall}</Box>
      </AppShell>,
    );
    const lines = (lastFrame() ?? "").split("\n").length;
    expect(lines).toBeLessThanOrEqual(8); // rows − 2, never the 60 rows of content
  });

  test("hides the rail labels on narrow terminals", () => {
    const { lastFrame } = render(
      <AppShell
        breadcrumb="portfolio"
        entries={ENTRIES}
        active="portfolio"
        keyHints="↑↓ move"
        columns={70}
        rows={40}
      >
        <Text>BODY</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("BODY");
    expect(frame).not.toContain("trends"); // rail hidden entirely when narrow
  });
});
