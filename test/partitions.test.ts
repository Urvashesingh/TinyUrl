import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

// Integration tests against the Postgres from docker-compose. These assert on
// physical storage -- which partition a row actually lands in -- because that
// is the only thing that proves partitioning is doing anything at all.

const prisma = new PrismaClient();
const TEST_CODE = "partTest";

before(async () => {
  await prisma.$executeRaw`DELETE FROM click_events WHERE code = ${TEST_CODE}`;
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM click_events WHERE code = ${TEST_CODE}`;
  await prisma.$disconnect();
});

/** Which physical partition is this row stored in? */
async function partitionOf(occurredAt: Date): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ partition: string }>>`
    SELECT tableoid::regclass::text AS partition
    FROM click_events
    WHERE code = ${TEST_CODE} AND "occurredAt" = ${occurredAt}
  `;
  return row?.partition ?? "";
}

async function insertClick(occurredAt: Date): Promise<void> {
  await prisma.clickEvent.create({
    data: { code: TEST_CODE, occurredAt, ipHash: "test" },
  });
}

describe("click_events partitioning", () => {
  it("is a partitioned table, not an ordinary one", async () => {
    const [row] = await prisma.$queryRaw<Array<{ kind: string }>>`
      SELECT relkind::text AS kind FROM pg_class WHERE relname = 'click_events'
    `;
    // 'p' is a partitioned table; 'r' would mean the migration silently did nothing.
    assert.equal(row.kind, "p");
  });

  it("routes a row to the partition for its month", async () => {
    const now = new Date();
    await insertClick(now);

    const expected = `click_events_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    assert.equal(await partitionOf(now), expected);
  });

  it("separates rows from different months into different partitions", async () => {
    const august = new Date(Date.UTC(2026, 7, 15, 12));
    const september = new Date(Date.UTC(2026, 8, 15, 12));

    await insertClick(august);
    await insertClick(september);

    const [a, b] = [await partitionOf(august), await partitionOf(september)];
    assert.equal(a, "click_events_2026_08");
    assert.equal(b, "click_events_2026_09");
    assert.notEqual(a, b);
  });

  it("accepts a row outside every declared range instead of failing", async () => {
    // Losing a click to a missing partition would be worse than the cost of
    // holding it in the default, so the default exists as a safety net.
    const farFuture = new Date(Date.UTC(2031, 0, 15, 12));
    await insertClick(farFuture);

    assert.equal(await partitionOf(farFuture), "click_events_default");
  });

  it("prunes to the partitions a time range needs", async () => {
    // The payoff: a "recent activity" query must not scan all history.
    const plan = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
      `EXPLAIN SELECT count(*) FROM click_events
       WHERE "occurredAt" >= DATE '2026-09-01' AND "occurredAt" < DATE '2026-10-01'`,
    );

    const text = plan.map((row) => Object.values(row)[0]).join("\n");

    assert.ok(text.includes("click_events_2026_09"), `expected the September partition:\n${text}`);
    assert.ok(!text.includes("click_events_2026_07"), `July must be pruned away:\n${text}`);
    assert.ok(!text.includes("click_events_2026_11"), `November must be pruned away:\n${text}`);
  });

  it("keeps the parent's indexes on every partition", async () => {
    // Declared once on the parent, created automatically on each child --
    // otherwise every new month would silently start life unindexed.
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'click_events_2026_09'
    `;

    const names = rows.map((r) => r.indexname).join(",");
    assert.ok(names.includes("code"), `expected a code index on the partition, got: ${names}`);
  });

  it("creates a partition idempotently", async () => {
    // The maintenance task runs on a schedule and must be safe to run twice.
    const first = await prisma.$queryRaw<Array<{ ensure_click_events_partition: string }>>`
      SELECT ensure_click_events_partition(DATE '2026-09-05')
    `;
    const second = await prisma.$queryRaw<Array<{ ensure_click_events_partition: string }>>`
      SELECT ensure_click_events_partition(DATE '2026-09-20')
    `;

    assert.equal(first[0].ensure_click_events_partition, "click_events_2026_09");
    assert.equal(second[0].ensure_click_events_partition, "click_events_2026_09");
  });
});
