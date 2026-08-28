import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import Redis from "ioredis";
import { WebSocket } from "ws";
import { config } from "../src/config.js";
import { attachLiveFeed, type LiveFeed } from "../src/liveFeed.js";
import { recordClicks } from "../src/trending.js";

// Integration test: a real HTTP server, a real WebSocket client, real Redis.

let redis: Redis;
let server: Server;
let feed: LiveFeed;
let origin: string;

interface TrendingMessage {
  type: string;
  entries: Array<{ code: string; clicks: number }>;
}

async function clearBuckets(): Promise<void> {
  const keys = await redis.keys("trending:*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/** Resolves on the first pushed message satisfying the predicate. */
function nextMatching(
  socket: WebSocket,
  match: (message: TrendingMessage) => boolean,
  timeoutMs = 15_000,
): Promise<TrendingMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a matching push")), timeoutMs);

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as TrendingMessage;
      if (match(message)) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

/** Closing is asynchronous on both ends; wait for it or the next test sees a
 * client that is on its way out but still counted. */
function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

function connect(): Promise<WebSocket> {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/live`);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

before(async () => {
  redis = new Redis(config.redisUrl);
  await clearBuckets();

  server = createServer((_req, res) => res.end());
  server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  feed = attachLiveFeed(server, redis);
});

after(async () => {
  await feed.close();
  await new Promise((resolve) => server.close(resolve));
  await clearBuckets();
  await redis.quit();
});

describe("attachLiveFeed", () => {
  it("pushes the current board to a client as soon as it connects", async () => {
    // Without this a new client stares at an empty page until the next tick.
    const socket = await connect();
    const message = await nextMatching(socket, (m) => m.type === "trending");

    assert.equal(message.type, "trending");
    assert.ok(Array.isArray(message.entries));
    await closeSocket(socket);
  });

  it("pushes updates as clicks arrive, without the client asking", async () => {
    const socket = await connect();

    await recordClicks(redis, [
      { code: "wsHot", occurredAt: new Date().toISOString() },
      { code: "wsHot", occurredAt: new Date().toISOString() },
      { code: "wsCold", occurredAt: new Date().toISOString() },
    ]);

    const message = await nextMatching(socket, (m) =>
      m.entries.some((e) => e.code === "wsHot" && e.clicks === 2),
    );

    const hot = message.entries.find((e) => e.code === "wsHot");
    const cold = message.entries.find((e) => e.code === "wsCold");
    assert.deepEqual(hot, { code: "wsHot", clicks: 2 });
    assert.deepEqual(cold, { code: "wsCold", clicks: 1 });

    await closeSocket(socket);
  });

  it("computes the board once and fans it out to every client", async () => {
    // The reason for pushing rather than letting clients poll: the expensive
    // union runs per tick, not per client.
    const sockets = await Promise.all([connect(), connect(), connect()]);
    assert.equal(feed.clientCount(), 3);

    await recordClicks(redis, [{ code: "wsFanout", occurredAt: new Date().toISOString() }]);

    const all = await Promise.all(
      sockets.map((s) => nextMatching(s, (m) => m.entries.some((e) => e.code === "wsFanout"))),
    );

    for (const message of all) {
      assert.ok(message.entries.some((e) => e.code === "wsFanout"));
    }

    await Promise.all(sockets.map(closeSocket));
  });

  it("exposes the same snapshot the REST endpoint serves", async () => {
    await recordClicks(redis, [{ code: "wsSnapshot", occurredAt: new Date().toISOString() }]);

    const socket = await connect();
    await nextMatching(socket, (m) => m.entries.some((e) => e.code === "wsSnapshot"));
    await closeSocket(socket);

    assert.ok(feed.snapshot().some((e) => e.code === "wsSnapshot"));
  });
});
