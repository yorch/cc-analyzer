import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { FilterableList } from "../../src/tui/components/FilterableList.tsx";

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

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const nextTick = () => wait(20);

describe("FilterableList", () => {
  test("filters items as the query is typed", async () => {
    const { stdin, lastFrame, unmount } = renderList();
    stdin.write("et"); // matches only "beta"
    await nextTick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("beta");
    expect(frame).not.toContain("alpha");
    expect(frame).toContain("1/4");
    unmount();
  });

  test("enter selects the highlighted (filtered) item", async () => {
    const result: { v: string | null } = { v: null };
    const { stdin, unmount } = renderList((i) => {
      result.v = i;
    });
    stdin.write("gam");
    await nextTick();
    stdin.write("\r"); // enter
    await nextTick();
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
    await nextTick();
    stdin.write("\x1b"); // escape -> clears query
    await wait(80); // Ink debounces a lone ESC to disambiguate escape sequences
    expect(backCalls).toBe(0);
    expect(lastFrame() ?? "").toContain("alpha"); // full list back
    stdin.write("\x1b"); // escape again -> back
    await wait(80);
    expect(backCalls).toBe(1);
    unmount();
  });
});
