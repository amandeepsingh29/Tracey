import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TraceSearchSchema } from "./signoz.js";

describe("TraceSearchSchema", () => {
  it("enforces bounded result and time ranges", () => {
    const tooLong = TraceSearchSchema.safeParse({
      start: 0,
      end: 8 * 24 * 60 * 60 * 1_000,
      serviceName: "tracey-api",
      limit: 50,
      offset: 0,
    });
    const tooMany = TraceSearchSchema.safeParse({
      start: 1,
      end: 2,
      serviceName: "tracey-api",
      limit: 201,
      offset: 0,
    });

    assert.equal(tooLong.success, false);
    assert.equal(tooMany.success, false);
  });

  it("applies safe pagination defaults", () => {
    const parsed = TraceSearchSchema.parse({
      start: 1,
      end: 2,
      serviceName: "tracey-api",
    });

    assert.equal(parsed.limit, 50);
    assert.equal(parsed.offset, 0);
  });
});
