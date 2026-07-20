# Versioned model pricing and cost attribution

Tracey attributes model cost from observed provider usage and an explicit immutable catalog version. It does not treat a provider console estimate or a model-name prefix as exact evidence.

## Catalog

Catalog version: `openai-standard-2026-07-16`  
Source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)  
Tier: standard processing  
Currency: USD  
Unit: USD per one million tokens

| Exact model ID | Input | Cached input | Output |
|---|---:|---:|---:|
| `gpt-5` | 1.25 | 0.125 | 10.00 |
| `gpt-5-2025-08-07` | 1.25 | 0.125 | 10.00 |
| `gpt-5-mini` | 0.25 | 0.025 | 2.00 |
| `gpt-5-mini-2025-08-07` | 0.25 | 0.025 | 2.00 |
| `gpt-5.4` | 2.50 | 0.25 | 15.00 |
| `gpt-5.4-2026-03-05` | 2.50 | 0.25 | 15.00 |
| `gpt-5.4-mini` | 0.75 | 0.075 | 4.50 |
| `gpt-5.4-mini-2026-03-17` | 0.75 | 0.075 | 4.50 |
| `text-embedding-3-small` | 0.02 | — | — |
| `text-embedding-3-large` | 0.13 | — | — |

Alias and snapshot IDs are separate exact catalog entries. Tracey never guesses that an unknown dated model has the same price as a prefix.

## Calculation

The Responses API reports total input, cached input, output, and reasoning-output tokens. Cached input is a subset of total input. Tracey computes:

```text
uncached_input = input - cached_input
cost = uncached_input * input_rate
     + cached_input * cached_input_rate
     + output * output_rate
```

Reasoning tokens are recorded separately but are already included in provider-reported output tokens, so they are not charged twice. Calculations use integer nano-USD per token and expose both `tracey.cost.nano_usd` and `tracey.cost.usd`.

Every model span records the catalog version, source, tier, currency, component costs, and attribution status. The API response also returns the exact total. `tracey.agent.cost.usd` is emitted only for exact catalog matches.

If the provider/model is absent, usage is inconsistent, or a rate cannot be represented exactly in nano-USD, Tracey returns `unresolved` with no estimated dollar amount. This prevents a stale or approximate rate from being presented as exact cost.

Pricing changes require adding a new catalog version and deploying it; historical spans retain the catalog version used when the call was observed.
