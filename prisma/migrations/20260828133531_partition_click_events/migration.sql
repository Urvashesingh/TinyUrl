-- Convert click_events into a RANGE-partitioned table, one partition per month.
--
-- Why: this is the only table that grows without bound -- one row per redirect,
-- forever. Three things get materially better once it is partitioned by time:
--
--   1. Retention becomes DROP TABLE on one partition: instant, and it reclaims
--      the disk immediately. DELETE on a huge table is slow, writes as much WAL
--      as the rows it removes, and leaves bloat for VACUUM to chase.
--   2. Time-ranged queries touch only the partitions they need (partition
--      pruning), so "last 7 days" stops scanning an index over all history.
--   3. Maintenance -- VACUUM, ANALYZE, REINDEX -- runs per partition instead of
--      over one enormous relation.
--
-- The cost is the constraint on line 3 of the new table: Postgres requires the
-- partition key to be part of every unique constraint, so the primary key has
-- to become (id, "occurredAt") rather than id alone.

-- Renaming a table renames neither its sequence nor its indexes, and index
-- names are unique per schema -- so every one of them has to be moved out of
-- the way before the new table can claim it.
ALTER TABLE "click_events" RENAME TO "click_events_legacy";
ALTER SEQUENCE "click_events_id_seq" RENAME TO "click_events_legacy_id_seq";
ALTER INDEX "click_events_pkey" RENAME TO "click_events_legacy_pkey";
ALTER INDEX "click_events_code_occurredAt_idx" RENAME TO "click_events_legacy_code_idx";
ALTER INDEX "click_events_occurredAt_idx" RENAME TO "click_events_legacy_occurred_idx";

CREATE TABLE "click_events" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "referer" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id", "occurredAt")
) PARTITION BY RANGE ("occurredAt");

-- Indexes declared on the parent are created automatically on every existing
-- and future partition, so this does not have to be repeated per month.
CREATE INDEX "click_events_code_occurredAt_idx" ON "click_events"("code", "occurredAt");
CREATE INDEX "click_events_occurredAt_idx" ON "click_events"("occurredAt");

-- Idempotent partition creation, used by this migration and by the scheduled
-- maintenance task. Kept in the database so it is available to a DBA, a cron
-- job, or the application without any of them needing to agree on naming.
CREATE OR REPLACE FUNCTION ensure_click_events_partition(target date)
RETURNS text AS $$
DECLARE
  start_date date := date_trunc('month', target)::date;
  end_date   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name  text := format('click_events_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  IF to_regclass(part_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "click_events" FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date
    );
  END IF;

  RETURN part_name;
END;
$$ LANGUAGE plpgsql;

-- One month back and three ahead, so the table works immediately and keeps
-- working unattended for a quarter.
DO $$
DECLARE
  month_offset int;
BEGIN
  FOR month_offset IN -1..3 LOOP
    PERFORM ensure_click_events_partition(
      (date_trunc('month', now()) + (month_offset || ' month')::interval)::date
    );
  END LOOP;
END;
$$;

-- A catch-all so an insert outside every declared range cannot fail. Losing a
-- click to a missing partition would be worse than the trade this makes: while
-- the default holds rows for a month, creating that month's partition requires
-- scanning it and fails if any conflict. Keeping partitions provisioned ahead
-- of time keeps the default empty, which is what the maintenance task is for.
CREATE TABLE "click_events_default" PARTITION OF "click_events" DEFAULT;

INSERT INTO "click_events" ("id", "code", "occurredAt", "userAgent", "referer", "ipHash")
SELECT "id", "code", "occurredAt", "userAgent", "referer", "ipHash"
FROM "click_events_legacy";

SELECT setval(
  'click_events_id_seq',
  GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "click_events"), 1)
);

DROP TABLE "click_events_legacy";
