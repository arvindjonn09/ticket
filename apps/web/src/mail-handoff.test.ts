import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

async function capture(path: string) {
  vi.resetModules();
  const replaceState = vi.fn();
  vi.stubGlobal("location", { href: `https://example.astrama.test${path}` });
  vi.stubGlobal("history", { state: { index: 1 }, replaceState });
  const handoff = await import("./mail-handoff");
  handoff.captureMailHandoff();
  return { ...handoff, replaceState };
}

it("scrubs the fragment before bootstrap and consumes its proof exactly once", async () => {
  const token = "x".repeat(43);
  const state = await capture(
    `/organisation?section=email&mailConnect=confirm&keep=yes#mailHandoff=${token}&anchor=kept`,
  );
  expect(state.replaceState).toHaveBeenCalledWith(
    { index: 1 },
    "",
    "/organisation?section=email&keep=yes#anchor=kept",
  );
  expect(state.takeMailHandoff()).toBe(token);
  state.captureMailHandoff();
  expect(state.takeMailHandoff()).toBeNull();
});

it.each([
  "/organisation?section=email&mailConnect=confirm#mailHandoff=invalid",
  `/organisation?section=email&mailConnect=confirm&mailHandoff=${"x".repeat(43)}`,
  `/organisation?section=email&mailConnect=confirm#mailHandoff=${"x".repeat(43)}&mailHandoff=${"y".repeat(43)}`,
])("rejects malformed, query-string or duplicate proof without retaining it", async (path) => {
  const state = await capture(path);
  expect(state.takeMailHandoff()).toBe("invalid");
  expect(state.takeMailHandoff()).toBeNull();
  expect(state.replaceState.mock.calls[0]?.[2]).not.toContain("mailHandoff");
});

it("does not accept proof on another route and preserves the ready return path", async () => {
  const wrong = await capture(
    `/tickets?section=email&mailConnect=confirm#mailHandoff=${"x".repeat(43)}`,
  );
  expect(wrong.takeMailHandoff()).toBeNull();
  expect(wrong.replaceState).toHaveBeenCalled();
  const ready = await capture("/organisation?section=email&mailConnect=ready");
  expect(ready.takeMailHandoff()).toBeNull();
  expect(ready.replaceState).not.toHaveBeenCalled();
});
