import { Kafka, Partitioners, logLevel as KafkaLogLevel, type Producer } from "kafkajs";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { ClickEvent, EventPublisher } from "./events.js";

export const CLICK_TOPIC = "clicks";

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: config.kafka.brokers,
    logLevel: KafkaLogLevel.WARN,
    retry: { initialRetryTime: 300, retries: 8 },
  });
}

/**
 * Topics are created explicitly rather than by auto-creation, which is
 * disabled on the broker. Auto-created topics silently take the broker
 * defaults -- usually one partition -- and partition count cannot be lowered
 * later, so an accidental default becomes permanent.
 */
export async function ensureClickTopic(kafka: Kafka): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();

  try {
    const existing = await admin.listTopics();
    if (!existing.includes(CLICK_TOPIC)) {
      await admin.createTopics({
        topics: [{ topic: CLICK_TOPIC, numPartitions: config.kafka.partitions, replicationFactor: 1 }],
      });
      logger.info({ topic: CLICK_TOPIC, partitions: config.kafka.partitions }, "created topic");
    }
  } finally {
    await admin.disconnect();
  }
}

export interface ClosableEventPublisher extends EventPublisher {
  close(): Promise<void>;
}

export async function createKafkaEventPublisher(
  kafka: Kafka,
  onDrop?: (error: unknown) => void,
): Promise<ClosableEventPublisher> {
  const producer: Producer = kafka.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    allowAutoTopicCreation: false,
  });

  await producer.connect();

  return {
    publishClick(event: ClickEvent) {
      // Keyed by code, so every event for a link lands on the same partition.
      // That buys per-link ordering and lets a consumer aggregate a link's
      // clicks without coordinating across partitions.
      //
      // Still not awaited: the producer batches and flushes in the background,
      // so the redirect never waits on the broker. The difference from Phase 3
      // is what happens on the other side -- the broker stores the event, so a
      // consumer that is down simply reads it later.
      void producer
        .send({
          topic: CLICK_TOPIC,
          messages: [{ key: event.code, value: JSON.stringify(event) }],
        })
        .catch((error) => onDrop?.(error));
    },

    async close() {
      await producer.disconnect();
    },
  };
}
