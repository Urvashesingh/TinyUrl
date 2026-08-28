import { PrismaClient } from "@prisma/client";
import { createApp } from "./app.js";
import { createLinkCache } from "./cache.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const prisma = new PrismaClient();
const cache = createLinkCache();

const server = createApp(prisma, cache).listen(config.port, () => {
  logger.info({ port: config.port }, "listening");
});

/** How long in-flight requests get to finish before we stop being polite. */
const SHUTDOWN_GRACE_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "draining connections");

  // A single hung keep-alive connection should not keep the pod alive forever.
  const forceExit = setTimeout(() => {
    logger.error("grace period elapsed, exiting immediately");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([prisma.$disconnect(), cache.close()]);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
