import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createBatcher } from "./batch.js";
import { CLICK_CHANNEL, parseClickEvent, type ClickEvent } from "./events.js";
import { CLICK_TOPIC, createKafka, ensureClickTopic } from "./kafka.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Analytics consumer. Runs as its own process, separate from the API.
 *
 * Separate because the two have opposite requirements: the API is latency
 * critical and scales with request volume, while this is throughput oriented
 * and scales with event volume. Sharing a process would let a slow batch
 * insert compete with a redirect for the same event loop.
 */
const prisma = new PrismaClient();
const shutdownHooks: Array<() => Promise<void>> = [];

async function writeClicks(events: ClickEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await prisma.clickEvent.createMany({
    data: events.map((event) => ({
      code: event.code,
      occurredAt: new Date(event.occurredAt),
      userAgent: event.userAgent ?? null,
      referer: event.referer ?? null,
      ipHash: event.ipHash ?? null,
    })),
  });

  logger.debug({ count: events.length }, "click batch written");
}

function decode(payload: string): ClickEvent | null {
  const event = parseClickEvent(payload);
  if (!event) {
    // One bad publisher must not be able to stop analytics for everyone, and a
    // poison message must never become an infinite redelivery loop.
    logger.warn({ payload: payload.slice(0, 200) }, "discarding unparseable click event");
  }
  return event;
}

/** Phase 3 transport. At-most-once: anything published while this is down is gone. */
async function startRedisConsumer(): Promise<void> {
  const subscriber = new Redis(config.redisUrl);
  let dropped = 0;

  const batcher = createBatcher<ClickEvent>({
    ...config.clickBatch,
    flush: writeClicks,
    onError(error, events) {
      dropped += events.length;
      logger.error({ err: error, count: events.length, dropped }, "click batch lost");
    },
  });

  subscriber.on("error", (error: Error) => {
    logger.warn({ err: error.message }, "subscriber connection problem");
  });

  subscriber.on("message", (channel, payload) => {
    if (channel !== CLICK_CHANNEL) {
      return;
    }

    const event = decode(payload);
    if (event) {
      batcher.add(event);
    }
  });

  await subscriber.subscribe(CLICK_CHANNEL);
  logger.info({ transport: "redis", channel: CLICK_CHANNEL }, "click consumer listening");

  shutdownHooks.push(async () => {
    // Stop taking new events first, then write out what is already buffered.
    await subscriber.unsubscribe(CLICK_CHANNEL).catch(() => {});
    await batcher.drain();
    await subscriber.quit().catch(() => subscriber.disconnect());
  });
}

/** Phase 4 transport. At-least-once: the broker keeps events until they are committed. */
async function startKafkaConsumer(): Promise<void> {
  const kafka = createKafka("click-consumer");
  await ensureClickTopic(kafka);

  const consumer = kafka.consumer({ groupId: config.kafka.groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: CLICK_TOPIC, fromBeginning: true });

  await consumer.run({
    // Kafka already hands us a batch, so the size/time batcher is redundant
    // here -- the broker has done the buffering.
    eachBatchAutoResolve: false,
    async eachBatch({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) {
      const events: ClickEvent[] = [];

      for (const message of batch.messages) {
        if (!isRunning() || isStale()) {
          // A rebalance took these partitions away; committing now would
          // acknowledge work another member is about to redo.
          return;
        }

        const event = message.value ? decode(message.value.toString()) : null;
        if (event) {
          events.push(event);
        }
      }

      // Write first, acknowledge second. This is what makes delivery
      // at-least-once rather than at-most-once: a crash between the write and
      // the commit replays the batch, so events can be duplicated but never
      // lost. Committing first would invert that and lose them instead.
      await writeClicks(events);

      for (const message of batch.messages) {
        resolveOffset(message.offset);
      }

      await commitOffsetsIfNecessary();
      await heartbeat();
    },
  });

  logger.info(
    { transport: "kafka", topic: CLICK_TOPIC, groupId: config.kafka.groupId },
    "click consumer listening",
  );

  shutdownHooks.push(() => consumer.disconnect());
}

if (config.eventTransport === "kafka") {
  await startKafkaConsumer();
} else {
  await startRedisConsumer();
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "consumer draining");

  const forceExit = setTimeout(() => {
    logger.error("grace period elapsed, exiting immediately");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  for (const hook of shutdownHooks) {
    await hook().catch((error) => logger.warn({ err: error }, "shutdown hook failed"));
  }

  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
