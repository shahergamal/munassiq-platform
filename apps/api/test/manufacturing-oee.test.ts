import test from "node:test";
import assert from "node:assert/strict";
import { oee } from "../src/lib/manufacturing/oee.ts";

test("OEE: availability × performance × quality, and utilization apart", () => {
  // 10 days × 8 h = 4,800 min; 480 down → 90% available; 3,600 standard min in 4,000 worked → 90%; 950 good of 1,000 → 95%.
  const r = oee({ plannedMinutes: 4800, downtimeMinutes: 480, runMinutes: 4000, standardMinutes: 3600, good: 950, scrap: 50 });
  assert.deepEqual([r.availability, r.performance, r.quality, r.oee], [0.9, 0.9, 0.95, 0.7695]);
  assert.equal(r.utilization, Math.round(4000 / 4320 * 10000) / 10000);
  assert.equal(oee({ plannedMinutes: 0, downtimeMinutes: 0, runMinutes: 0, standardMinutes: 0, good: 0, scrap: 0 }).oee, 0, "an idle center reads 0, not NaN");
});
