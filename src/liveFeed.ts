import type { Server } from "node:http";
import type Redis from "ioredis";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { readTrending, type TrendingEntry } from "./trending.js";

export interface LiveFeed {
  /** Latest computed leaderboard, also served by the REST endpoint. */
  snapshot(): TrendingEntry[];
  clientCount(): number;
  close(): Promise<void>;
}

/**
 * Pushes the trending leaderboard to connected WebSocket clients.
 *
 * Why WebSockets rather than polling: a leaderboard that changes every couple
 * of seconds means every client polling on a timer, and N clients polling
 * independently means N unioned reads of Redis per interval. Here the union
 * runs once per tick regardless of how many clients are attached, and the
 * result fans out from memory.
 *
 * Server-sent events would work equally well for this -- the traffic is
 * entirely one-directional. WebSockets are used because the phase calls for
 * them, and because the next obvious feature (subscribing to one link's live
 * count) does need a client-to-server channel.
 */
export function attachLiveFeed(server: Server, redis: Redis, path = "/live"): LiveFeed {
  const wss = new WebSocketServer({ server, path });
  let latest: TrendingEntry[] = [];
  let closed = false;

  wss.on("connection", (socket) => {
    // Send the current state immediately; otherwise a new client stares at an
    // empty board until the next tick.
    send(socket, latest);

    socket.on("error", (error) => {
      logger.debug({ err: error.message }, "live feed socket error");
    });
  });

  function send(socket: WebSocket, entries: TrendingEntry[]): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // Backpressure: if a client is not draining, its buffer grows in our
    // process until we run out of memory. A leaderboard is worthless when
    // stale, so a slow client is dropped rather than queued for.
    if (socket.bufferedAmount > 1_000_000) {
      logger.warn("dropping live feed client that is not keeping up");
      socket.terminate();
      return;
    }

    socket.send(JSON.stringify({ type: "trending", entries, at: new Date().toISOString() }));
  }

  async function tick(): Promise<void> {
    try {
      latest = await readTrending(redis);
    } catch (error) {
      // Keep serving the previous snapshot. A leaderboard is a nice-to-have,
      // and it must not be able to take the API process down with it.
      logger.warn({ err: error }, "trending refresh failed, serving last snapshot");
      return;
    }

    for (const socket of wss.clients) {
      send(socket, latest);
    }
  }

  const timer = setInterval(() => void tick(), config.trending.refreshMs);
  timer.unref();
  void tick();

  return {
    snapshot: () => latest,
    clientCount: () => wss.clients.size,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      for (const socket of wss.clients) {
        socket.close(1001, "server shutting down");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
