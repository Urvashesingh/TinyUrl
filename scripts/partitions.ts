import { PrismaClient } from "@prisma/client";
import { config } from "../src/config.js";
import { logger } from "../src/logger.js";

/**
 * Partition maintenance for click_events. Meant to run on a schedule -- a cron
 * job, a Kubernetes CronJob, or by hand.
 *
 * Two jobs, and the first one is the load-bearing one:
 *
 *   ensure   create partitions for the months ahead. If the month a row falls
 *            into has no partition, the row lands in the default partition --
 *            and while the default holds rows for a month, creating that
 *            month's partition requires scanning the default and FAILS if any
 *            conflict. Running ahead of time is what keeps the default empty.
 *
 *   prune    drop partitions past the retention horizon. This is the whole
 *            point of partitioning: DROP TABLE is instant and returns the disk
 *            immediately, where DELETE writes as much WAL as the rows it
 *            removes and leaves bloat behind.
 */
const prisma = new PrismaClient();

function monthsFromNow(offset: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function partitionName(month: Date): string {
  const year = month.getUTCFullYear();
  const monthNumber = String(month.getUTCMonth() + 1).padStart(2, "0");
  return `click_events_${year}_${monthNumber}`;
}

async function ensureAhead(months: number): Promise<string[]> {
  const created: string[] = [];

  for (let offset = 0; offset <= months; offset += 1) {
    const month = monthsFromNow(offset);
    const [row] = await prisma.$queryRaw<Array<{ ensure_click_events_partition: string }>>`
      SELECT ensure_click_events_partition(${month}::date)
    `;
    created.push(row.ensure_click_events_partition);
  }

  return created;
}

async function pruneOlderThan(months: number): Promise<string[]> {
  const dropped: string[] = [];
  const horizon = monthsFromNow(-months);

  const partitions = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_inherits i ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'click_events'
      AND c.relname <> 'click_events_default'
  `;

  for (const { name } of partitions) {
    const match = /^click_events_(\d{4})_(\d{2})$/.exec(name);
    if (!match) {
      continue;
    }

    const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    if (month < horizon) {
      // Detach first so a long-running query holding the partition cannot take
      // an ACCESS EXCLUSIVE lock on the parent along with it.
      await prisma.$executeRawUnsafe(`ALTER TABLE click_events DETACH PARTITION "${name}"`);
      await prisma.$executeRawUnsafe(`DROP TABLE "${name}"`);
      dropped.push(name);
    }
  }

  return dropped;
}

const created = await ensureAhead(config.partitions.provisionMonthsAhead);
const dropped = await pruneOlderThan(config.partitions.retentionMonths);

logger.info(
  { ensured: created, dropped, retentionMonths: config.partitions.retentionMonths },
  "partition maintenance complete",
);

await prisma.$disconnect();
