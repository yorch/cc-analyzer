import { describe, expect, test } from "bun:test";
import { Text } from "ink";
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

  test("hides the rail labels on narrow terminals", () => {
    const { lastFrame } = render(
      <AppShell
        breadcrumb="portfolio"
        entries={ENTRIES}
        active="portfolio"
        keyHints="↑↓ move"
        columns={70}
      >
        <Text>BODY</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("BODY");
    expect(frame).not.toContain("trends"); // rail hidden entirely when narrow
  });
});
