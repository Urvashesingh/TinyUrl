-- CreateTable
CREATE TABLE "click_events" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "referer" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "click_events_code_occurredAt_idx" ON "click_events"("code", "occurredAt");

-- CreateIndex
CREATE INDEX "click_events_occurredAt_idx" ON "click_events"("occurredAt");
