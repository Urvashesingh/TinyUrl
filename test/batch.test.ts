import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBatcher } from "../src/batch.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createBatcher", () => {
  it("flushes as soon as the batch is full", async () => {
    const flushed: number[][] = [];
    const batcher = createBatcher<number>({
      maxSize: 3,
      maxDelayMs: 10_000,
      async flush(items) {
        flushed.push(items);
      },
    });

    batcher.add(1);
    batcher.add(2);
    assert.deepEqual(flushed, [], "must not flush before the batch is full");

    batcher.add(3);
    await tick(10);
    assert.deepEqual(flushed, [[1, 2, 3]]);
  });

  it("flushes on the timer when traffic goes quiet", async () => {
    // Without this, the last few events of a quiet period sit in memory
    // indefinitely and the data silently lags reality.
    const flushed: number[][] = [];
    const batcher = createBatcher<number>({
      maxSize: 100,
      maxDelayMs: 30,
      async flush(items) {
        flushed.push(items);
      },
    });

    batcher.add(1);
    assert.equal(batcher.size(), 1);

    await tick(80);
    assert.deepEqual(flushed, [[1]]);
    assert.equal(batcher.size(), 0);
  });

  it("keeps accepting items after a flush", async () => {
    const flushed: number[][] = [];
    const batcher = createBatcher<number>({
      maxSize: 2,
      maxDelayMs: 20,
      async flush(items) {
        flushed.push(items);
      },
    });

    batcher.add(1);
    batcher.add(2);
    await tick(10);
    batcher.add(3);
    await batcher.drain();

    assert.deepEqual(flushed, [[1, 2], [3]]);
  });

  it("drains what is buffered, which is what makes shutdown lossless", async () => {
    const flushed: number[][] = [];
    const batcher = createBatcher<number>({
      maxSize: 100,
      maxDelayMs: 10_000,
      async flush(items) {
        flushed.push(items);
      },
    });

    batcher.add(1);
    batcher.add(2);
    await batcher.drain();

    assert.deepEqual(flushed, [[1, 2]]);
  });

  it("drains cleanly when nothing is buffered", async () => {
    let calls = 0;
    const batcher = createBatcher<number>({
      maxSize: 10,
      maxDelayMs: 10,
      async flush() {
        calls += 1;
      },
    });

    await batcher.drain();
    assert.equal(calls, 0);
  });

  it("survives a failing flush and keeps going", async () => {
    // A database blip must cost one batch, not the consumer process.
    const errors: number[][] = [];
    let attempt = 0;
    const batcher = createBatcher<number>({
      maxSize: 2,
      maxDelayMs: 10_000,
      async flush(items) {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("database is having a moment");
        }
        errors.push(items);
      },
      onError(_error, items) {
        errors.push([-1, ...items]);
      },
    });

    batcher.add(1);
    batcher.add(2);
    await tick(10);

    batcher.add(3);
    batcher.add(4);
    await batcher.drain();

    assert.deepEqual(errors, [[-1, 1, 2], [3, 4]]);
  });

  it("does not interleave concurrent flushes", async () => {
    // Two overlapping flushes could reorder writes; the batcher serialises them.
    const order: string[] = [];
    const batcher = createBatcher<number>({
      maxSize: 1,
      maxDelayMs: 10_000,
      async flush(items) {
        order.push(`start-${items[0]}`);
        await tick(20);
        order.push(`end-${items[0]}`);
      },
    });

    batcher.add(1);
    batcher.add(2);
    await batcher.drain();

    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
  });
});
