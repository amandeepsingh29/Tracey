export const OPENAI_STANDARD_PRICE_CATALOG_VERSION = "openai-standard-2026-07-16";
export const OPENAI_PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";

export interface ModelPrice {
  provider: string;
  model: string;
  effectiveFrom: string;
  currency: "USD";
  tier: "standard";
  perMillionTokensUsd: {
    input: number;
    cachedInput: number | null;
    output: number;
  };
}

const openAIPrices: ModelPrice[] = [
  {
    provider: "openai",
    model: "gpt-5",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 1.25, cachedInput: 0.125, output: 10 },
  },
  {
    provider: "openai",
    model: "gpt-5-2025-08-07",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 1.25, cachedInput: 0.125, output: 10 },
  },
  {
    provider: "openai",
    model: "gpt-5-mini",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 0.25, cachedInput: 0.025, output: 2 },
  },
  {
    provider: "openai",
    model: "gpt-5-mini-2025-08-07",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 0.25, cachedInput: 0.025, output: 2 },
  },
  {
    provider: "openai",
    model: "gpt-5.4",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 2.5, cachedInput: 0.25, output: 15 },
  },
  {
    provider: "openai",
    model: "gpt-5.4-2026-03-05",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 2.5, cachedInput: 0.25, output: 15 },
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 0.75, cachedInput: 0.075, output: 4.5 },
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini-2026-03-17",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 0.75, cachedInput: 0.075, output: 4.5 },
  },
  {
    provider: "openai",
    model: "text-embedding-3-small",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 0.02, cachedInput: null, output: 0 },
  },
  {
    provider: "openai",
    model: "text-embedding-3-large",
    effectiveFrom: "2026-07-16",
    currency: "USD",
    tier: "standard",
    perMillionTokensUsd: { input: 0.13, cachedInput: null, output: 0 },
  },
];

export const MODEL_PRICE_CATALOG: readonly ModelPrice[] = Object.freeze(openAIPrices);

export interface ModelUsageForCost {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ExactModelCost {
  status: "exact";
  catalogVersion: string;
  source: string;
  provider: string;
  model: string;
  currency: "USD";
  tier: "standard";
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  inputCostNanoUsd: number;
  cachedInputCostNanoUsd: number;
  outputCostNanoUsd: number;
  totalCostNanoUsd: number;
  totalCostUsd: number;
}

export interface UnresolvedModelCost {
  status: "unresolved";
  catalogVersion: string;
  source: string;
  provider: string;
  model: string;
  reason: "model_not_in_catalog" | "invalid_usage" | "rate_not_nano_usd_exact";
}

export type ModelCostAttribution = ExactModelCost | UnresolvedModelCost;

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nanoUsdPerToken(usdPerMillionTokens: number): number | undefined {
  const value = usdPerMillionTokens * 1_000;
  return Number.isSafeInteger(value) ? value : undefined;
}

export function calculateModelCost(usage: ModelUsageForCost): ModelCostAttribution {
  const common = {
    catalogVersion: OPENAI_STANDARD_PRICE_CATALOG_VERSION,
    source: OPENAI_PRICE_SOURCE,
    provider: usage.provider,
    model: usage.model,
  };
  if (
    !nonNegativeInteger(usage.inputTokens) ||
    !nonNegativeInteger(usage.cachedInputTokens) ||
    !nonNegativeInteger(usage.outputTokens) ||
    usage.cachedInputTokens > usage.inputTokens
  ) {
    return { status: "unresolved", ...common, reason: "invalid_usage" };
  }
  const price = MODEL_PRICE_CATALOG.find(
    (candidate) => candidate.provider === usage.provider && candidate.model === usage.model,
  );
  if (!price) return { status: "unresolved", ...common, reason: "model_not_in_catalog" };
  const inputRate = nanoUsdPerToken(price.perMillionTokensUsd.input);
  const cachedRate = price.perMillionTokensUsd.cachedInput === null
    ? usage.cachedInputTokens === 0 ? 0 : undefined
    : nanoUsdPerToken(price.perMillionTokensUsd.cachedInput);
  const outputRate = nanoUsdPerToken(price.perMillionTokensUsd.output);
  if (inputRate === undefined || cachedRate === undefined || outputRate === undefined) {
    return { status: "unresolved", ...common, reason: "rate_not_nano_usd_exact" };
  }
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
  const inputCostNanoUsd = uncachedInputTokens * inputRate;
  const cachedInputCostNanoUsd = usage.cachedInputTokens * cachedRate;
  const outputCostNanoUsd = usage.outputTokens * outputRate;
  const totalCostNanoUsd = inputCostNanoUsd + cachedInputCostNanoUsd + outputCostNanoUsd;
  if (!Number.isSafeInteger(totalCostNanoUsd)) {
    return { status: "unresolved", ...common, reason: "invalid_usage" };
  }
  return {
    status: "exact",
    ...common,
    currency: price.currency,
    tier: price.tier,
    inputTokens: usage.inputTokens,
    uncachedInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    inputCostNanoUsd,
    cachedInputCostNanoUsd,
    outputCostNanoUsd,
    totalCostNanoUsd,
    totalCostUsd: totalCostNanoUsd / 1_000_000_000,
  };
}
