"use client";

import { useEffect, useState } from "react";

export function usePersistedDraft(key: string) {
  const [value, setValue] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setValue(window.localStorage.getItem(key) ?? "");
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  }, [hydrated, key, value]);

  return [value, setValue] as const;
}
