import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";

const MAX_SESSION_BYTES = 64 * 1_024 * 1_024;
const MAX_SESSION_LINES = 100_000;
const MAX_CONTENT_CHARACTERS = 100_000;

export type CodexForensicEventKind =
  | "prompt"
  | "response"
  | "reasoning"
  | "tool_call"
  | "tool_result";

export type CodexForensicEvent = {
  id: string;
  timestamp: string;
  kind: CodexForensicEventKind;
  label: string;
  content?: string;
  toolName?: string;
  callId?: string;
  phase?: string;
  sensitive: boolean;
  raw: Record<string, unknown>;
};

export type CodexForensicTurn = {
  conversationId: string;
  turnIndex: number;
  turnId?: string;
  sourceFile: string;
  events: CodexForensicEvent[];
};

export type CodexForensicTurnSummary = {
  conversationId: string;
  turnIndex: number;
  turnId?: string;
  prompt: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  eventCount: number;
  toolNames: string[];
  status: "complete" | "incomplete";
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, MAX_CONTENT_CHARACTERS);
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2).slice(0, MAX_CONTENT_CHARACTERS);
  } catch {
    return String(value).slice(0, MAX_CONTENT_CHARACTERS);
  }
}

function messageContent(payload: JsonRecord): string | undefined {
  if (!Array.isArray(payload.content)) return undefined;
  const values = payload.content.flatMap((entry) => {
    const item = record(entry);
    if (!item) return [];
    const value = string(item.text) ?? string(item.input_text) ?? string(item.output_text);
    return value ? [value] : [];
  });
  return values.length > 0 ? values.join("\n\n").slice(0, MAX_CONTENT_CHARACTERS) : undefined;
}

function reasoningContent(payload: JsonRecord): string | undefined {
  if (!Array.isArray(payload.summary)) return undefined;
  const values = payload.summary.flatMap((entry) => {
    const item = record(entry);
    const value = item ? string(item.text) : undefined;
    return value ? [value] : [];
  });
  return values.length > 0 ? values.join("\n\n").slice(0, MAX_CONTENT_CHARACTERS) : undefined;
}

function userFacingPrompt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const requestMarker = "## My request for Codex:";
  const markedRequest = value.lastIndexOf(requestMarker);
  const trimmed = (markedRequest >= 0
    ? value.slice(markedRequest + requestMarker.length)
    : value).trim();
  if (/\[\d+\]\s+(?:tool|assistant|user)\b/i.test(trimmed)) return undefined;
  if (
    trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("<recommended_plugins>")
    || trimmed.startsWith("<permissions instructions>")
    || trimmed.startsWith("The following is the Codex agent history added since your last approval assessment.")
    || trimmed.startsWith("Review the Codex agent history")
  ) return undefined;
  return trimmed || undefined;
}

function forensicRawPayload(payload: JsonRecord, includeSensitive: boolean): JsonRecord {
  const protect = (value: unknown, key?: string): unknown => {
    if (key === "encrypted_content") return "[ENCRYPTED_REASONING_NOT_AVAILABLE]";
    if (typeof value === "string") {
      const bounded = value.length > MAX_CONTENT_CHARACTERS
        ? `${value.slice(0, MAX_CONTENT_CHARACTERS)}\n[TRUNCATED]`
        : value;
      return includeSensitive ? bounded : redactForensicContent(bounded).content;
    }
    if (Array.isArray(value)) return value.map((item) => protect(item));
    const object = record(value);
    if (!object) return value;
    return Object.fromEntries(Object.entries(object).map(([childKey, child]) => [childKey, protect(child, childKey)]));
  };
  return protect(payload) as JsonRecord;
}

const credentialPatterns: RegExp[] = [
  /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{16,}\b/g,
  /((?:authorization|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret|cookie)\s*[:=]\s*["']?(?:bearer\s+)?)([^"',;\s}\]]+)/gi,
  /((?:OPENROUTER_API_KEY|OPENAI_API_KEY|SIGNOZ_API_KEY|SIGNOZ_INGESTION_KEY)\s*=\s*)([^\s"',;]+)/gi,
];

export function redactForensicContent(value: string): { content: string; sensitive: boolean } {
  let content = value;
  for (const pattern of credentialPatterns) {
    content = content.replace(pattern, (match, prefix: string | undefined) =>
      typeof prefix === "string" && prefix.length < match.length
        ? `${prefix}[REDACTED_SENSITIVE_VALUE]`
        : "[REDACTED_SENSITIVE_VALUE]");
  }
  return { content, sensitive: content !== value };
}

async function findSessionFile(root: string, conversationId: string): Promise<string | undefined> {
  const expectedSuffix = `${conversationId}.jsonl`;
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && visited < 20_000) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(expectedSuffix)) return path;
    }
  }
  return undefined;
}

function forensicEvent(
  conversationId: string,
  index: number,
  timestamp: string,
  payload: JsonRecord,
  includeSensitive: boolean,
): CodexForensicEvent | undefined {
  const payloadType = string(payload.type);
  const role = string(payload.role);
  let kind: CodexForensicEventKind | undefined;
  let label: string | undefined;
  let content: string | undefined;
  let toolName: string | undefined;
  if (payloadType === "message" && role === "user") {
    kind = "prompt";
    label = "User prompt";
    content = userFacingPrompt(messageContent(payload));
    if (!content) return undefined;
  } else if (payloadType === "message" && role === "assistant") {
    kind = "response";
    label = string(payload.phase) === "final" ? "Final response" : "Assistant response";
    content = messageContent(payload);
  } else if (payloadType === "reasoning") {
    kind = "reasoning";
    label = "Reasoning summary";
    content = reasoningContent(payload);
  } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    kind = "tool_call";
    toolName = string(payload.name) ?? "unknown";
    label = `Tool call · ${toolName}`;
    content = stringify(payload.arguments ?? payload.input);
  } else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    kind = "tool_result";
    label = "Tool result";
    content = stringify(payload.output);
  }
  if (!kind || !label) return undefined;
  const protectedContent = content ? redactForensicContent(content) : undefined;
  const callId = string(payload.call_id);
  const phase = string(payload.phase);
  return {
    id: `local:${conversationId}:${index}`,
    timestamp,
    kind,
    label,
    ...(protectedContent?.content ? { content: includeSensitive ? content! : protectedContent.content } : {}),
    ...(toolName ? { toolName } : {}),
    ...(callId ? { callId } : {}),
    ...(phase ? { phase } : {}),
    sensitive: protectedContent?.sensitive ?? false,
    raw: forensicRawPayload(payload, includeSensitive),
  };
}

async function readSessionTurns(
  sourceFile: string,
  conversationId: string,
  includeSensitive: boolean,
): Promise<Array<{ turnId?: string; events: CodexForensicEvent[] }>> {
  const fileStat = await stat(sourceFile);
  if (fileStat.size > MAX_SESSION_BYTES) throw new Error("Codex session exceeds the local forensic size limit");
  const turns: Array<{ turnId?: string; events: CodexForensicEvent[] }> = [];
  let active: { turnId?: string; events: CodexForensicEvent[] } | undefined;
  let lineIndex = 0;
  const lines = createInterface({ input: createReadStream(sourceFile, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    lineIndex += 1;
    if (lineIndex > MAX_SESSION_LINES) throw new Error("Codex session exceeds the local forensic line limit");
    let item: JsonRecord;
    try {
      item = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    const payload = record(item.payload);
    if (!payload) continue;
    if (item.type === "turn_context") {
      if (active?.events.length) turns.push(active);
      const turnId = string(payload.turn_id);
      active = { ...(turnId ? { turnId } : {}), events: [] };
      continue;
    }
    if (!active || item.type !== "response_item") continue;
    const timestamp = string(item.timestamp);
    if (!timestamp) continue;
    const event = forensicEvent(conversationId, lineIndex, timestamp, payload, includeSensitive);
    if (event) active.events.push(event);
  }
  if (active?.events.length) turns.push(active);
  return turns;
}

async function recentSessionFiles(root: string, since: number): Promise<Array<{ path: string; conversationId: string; modifiedAt: number }>> {
  const pending = [root];
  const files: Array<{ path: string; conversationId: string; modifiedAt: number }> = [];
  let visited = 0;
  while (pending.length > 0 && visited < 20_000) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      const match = entry.isFile() && entry.name.endsWith(".jsonl")
        ? entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
        : undefined;
      if (!match?.[1]) continue;
      try {
        const fileStat = await stat(path);
        if (fileStat.mtimeMs >= since) files.push({ path, conversationId: match[1], modifiedAt: fileStat.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return files.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, 60);
}

export async function listRecentCodexForensicTurns(input: {
  sessionsDir: string;
  since: number;
  limit: number;
}): Promise<CodexForensicTurnSummary[]> {
  const files = await recentSessionFiles(input.sessionsDir, input.since);
  const conversations = await Promise.all(files.map(async (file) => {
    try {
      const turns = await readSessionTurns(file.path, file.conversationId, false);
      return turns.map((turn, index): CodexForensicTurnSummary | undefined => {
        const prompt = turn.events.find(({ kind }) => kind === "prompt");
        if (!prompt?.content) return undefined;
        const endedAt = turn.events.at(-1)?.timestamp ?? prompt.timestamp;
        const toolNames = [...new Set(turn.events.flatMap((event) => event.toolName ? [event.toolName] : []))];
        return {
          conversationId: file.conversationId,
          turnIndex: index + 1,
          ...(turn.turnId ? { turnId: turn.turnId } : {}),
          prompt: prompt.content.slice(0, 500),
          startedAt: prompt.timestamp,
          endedAt,
          durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(prompt.timestamp)),
          eventCount: turn.events.length,
          toolNames,
          status: turn.events.some(({ kind, phase }) => kind === "response" && phase === "final") ? "complete" : "incomplete",
        };
      }).filter((turn): turn is CodexForensicTurnSummary => Boolean(turn));
    } catch {
      return [];
    }
  }));
  return conversations.flat()
    .filter(({ startedAt }) => Date.parse(startedAt) >= input.since)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, input.limit);
}

export async function readCodexForensicTurn(input: {
  sessionsDir: string;
  conversationId: string;
  turnIndex?: number;
  at?: number;
  includeSensitive: boolean;
}): Promise<CodexForensicTurn | undefined> {
  const sourceFile = await findSessionFile(input.sessionsDir, input.conversationId);
  if (!sourceFile) return undefined;
  const turns = await readSessionTurns(sourceFile, input.conversationId, input.includeSensitive);
  const selectedIndex = input.at !== undefined
    ? turns.map((turn, index) => ({ turn, index })).sort((left, right) => {
        const leftTimestamp = Date.parse(left.turn.events.find(({ kind }) => kind === "prompt")?.timestamp ?? "");
        const rightTimestamp = Date.parse(right.turn.events.find(({ kind }) => kind === "prompt")?.timestamp ?? "");
        return Math.abs((Number.isFinite(leftTimestamp) ? leftTimestamp : 0) - input.at!)
          - Math.abs((Number.isFinite(rightTimestamp) ? rightTimestamp : 0) - input.at!);
      })[0]?.index
    : input.turnIndex !== undefined
      ? input.turnIndex - 1
      : turns.length - 1;
  if (selectedIndex === undefined) return undefined;
  const turn = turns[selectedIndex];
  if (!turn) return undefined;
  return {
    conversationId: input.conversationId,
    turnIndex: selectedIndex + 1,
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    sourceFile: sourceFile.split("/").at(-1) ?? sourceFile,
    events: turn.events,
  };
}
