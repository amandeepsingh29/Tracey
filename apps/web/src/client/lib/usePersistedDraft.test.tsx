import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePersistedDraft } from "./usePersistedDraft";

describe("persisted operational drafts", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } satisfies Storage });
  });

  it("restores an unsent draft after navigation or reload", () => {
    const first = renderHook(() => usePersistedDraft("tracey.test-draft"));
    act(() => first.result.current[1]("operator note in progress"));
    expect(window.localStorage.getItem("tracey.test-draft")).toBe("operator note in progress");
    first.unmount();

    const restored = renderHook(() => usePersistedDraft("tracey.test-draft"));
    expect(restored.result.current[0]).toBe("operator note in progress");
  });

  it("removes completed drafts from local storage", () => {
    window.localStorage.setItem("tracey.test-draft", "complete me");
    const draft = renderHook(() => usePersistedDraft("tracey.test-draft"));
    act(() => draft.result.current[1](""));
    expect(window.localStorage.getItem("tracey.test-draft")).toBeNull();
  });
});
