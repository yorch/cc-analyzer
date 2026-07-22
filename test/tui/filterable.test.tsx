import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { FilterableList } from "../../src/tui/components/FilterableList.tsx";
import { waitFor, waitForFrame } from "../helpers/tui.ts";

const items = ["alpha", "beta", "gamma", "delta"];

function renderList(onSelect: (i: string) => void = () => {}, onBack: () => void = () => {}) {
  return render(
    <FilterableList
      items={items}
      filterText={(i) => i}
      onSelect={onSelect}
      onBack={onBack}
      renderItem={(i, selected) => <Text>{selected ? `> ${i}` : `  ${i}`}</Text>}
    />,
  );
}

describe("FilterableList", () => {
  test("filters items as the query is typed", async () => {
    const { stdin, lastFrame, unmount } = renderList();
    stdin.write("et"); // matches only "beta"
    await waitForFrame(lastFrame, "1/4"); // count drops to one match
    const frame = lastFrame() ?? "";
    expect(frame).toContain("beta");
    expect(frame).not.toContain("alpha");
    expect(frame).toContain("1/4");
    unmount();
  });

  test("enter selects the highlighted (filtered) item", async () => {
    const result: { v: string | null } = { v: null };
    const { stdin, lastFrame, unmount } = renderList((i) => {
      result.v = i;
    });
    stdin.write("gam");
    await waitForFrame(lastFrame, "1/4"); // filter down to the single match first
    stdin.write("\r"); // enter
    await waitFor(() => result.v !== null);
    expect(result.v).toBe("gamma");
    unmount();
  });

  test("escape clears a non-empty query before calling onBack", async () => {
    let backCalls = 0;
    const { stdin, lastFrame, unmount } = renderList(
      () => {},
      () => {
        backCalls++;
      },
    );
    stdin.write("be");
    await waitForFrame(lastFrame, "1/4"); // query applied (one match) before we clear it
    stdin.write("\x1b"); // escape -> clears query
    // Ink debounces a lone ESC to disambiguate escape sequences, so the clear
    // lands a little later; poll for the full list to return instead of sleeping.
    await waitForFrame(lastFrame, "alpha");
    expect(backCalls).toBe(0);
    expect(lastFrame() ?? "").toContain("alpha"); // full list back
    stdin.write("\x1b"); // escape again -> back
    await waitFor(() => backCalls === 1); // second ESC (also debounced) fires onBack
    expect(backCalls).toBe(1);
    unmount();
  });
});
