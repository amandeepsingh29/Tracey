export function relativeTime(value?: string): string {
  if (!value) return "Unknown time";
  const delta = Date.now() - new Date(value).getTime();
  const absolute = Math.abs(delta);
  if (absolute < 60_000) return "just now";
  if (absolute < 3_600_000) return `${Math.floor(absolute / 60_000)}m ago`;
  if (absolute < 86_400_000) return `${Math.floor(absolute / 3_600_000)}h ago`;
  return `${Math.floor(absolute / 86_400_000)}d ago`;
}

export function dateTime(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function compactNumber(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function duration(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

export function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
