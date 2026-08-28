import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Kafka, Partitioners, logLevel } from "kafkajs";
import { config } from "../src/config.js";

// Integration tests against the Kafka from docker-compose. These use their own
// topic so they cannot disturb the real click stream.

const TOPIC = `clicks-test-${Date.now()}`;
const PARTITIONS = 3;

const kafka = new Kafka({
  clientId: "kafka-test",
  brokers: config.kafka.brokers,
  logLevel: logLevel.NOTHING,
});

const producer = kafka.producer({
  createPartitioner: Partitioners.DefaultPartitioner,
  allowAutoTopicCreation: false,
});

before(async () => {
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [{ topic: TOPIC, numPartitions: PARTITIONS, replicationFactor: 1 }],
  });
  await admin.disconnect();
  await producer.connect();
});

after(async () => {
  await producer.disconnect();
  const admin = kafka.admin();
  await admin.connect();
  await admin.deleteTopics({ topics: [TOPIC] }).catch(() => {});
  await admin.disconnect();
});

describe("kafka click transport", () => {
  it("sends every event for one key to a single partition", async () => {
    // This is what buys per-link ordering, and what lets a consumer aggregate
    // one link's clicks without coordinating across partitions.
    const results = await producer.send({
      topic: TOPIC,
      messages: Array.from({ length: 12 }, (_, i) => ({
        key: "sameCode",
        value: JSON.stringify({ code: "sameCode", occurredAt: new Date().toISOString(), i }),
      })),
    });

    const partitions = new Set(results.map((r) => r.partition));
    assert.equal(partitions.size, 1, "one key must map to exactly one partition");
  });

  it("spreads different keys across partitions", async () => {
    const seen = new Set<number>();

    for (let i = 0; i < 40; i += 1) {
      const [result] = await producer.send({
        topic: TOPIC,
        messages: [{ key: `code-${i}`, value: "{}" }],
      });
      seen.add(result.partition);
    }

    assert.ok(seen.size > 1, `expected keys to spread, all landed on ${[...seen]}`);
  });

  it("retains events published while no consumer exists, and replays them", async () => {
    // The whole point of Phase 4. Nothing is subscribed at the moment these
    // are published; a consumer created afterwards must still receive them.
    const marker = `retained-${Date.now()}`;
    await producer.send({
      topic: TOPIC,
      messages: [
        { key: marker, value: JSON.stringify({ code: marker, n: 1 }) },
        { key: marker, value: JSON.stringify({ code: marker, n: 2 }) },
      ],
    });

    const consumer = kafka.consumer({ groupId: `test-replay-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

    const received: number[] = [];
    const gotBoth = new Promise<void>((resolve) => {
      void consumer.run({
        async eachMessage({ message }) {
          if (message.key?.toString() !== marker) {
            return;
          }
          received.push((JSON.parse(message.value!.toString()) as { n: number }).n);
          if (received.length === 2) {
            resolve();
          }
        },
      });
    });

    await gotBoth;
    await consumer.disconnect();

    // Same key, so same partition, so ordering is guaranteed.
    assert.deepEqual(received, [1, 2]);
  });
});
