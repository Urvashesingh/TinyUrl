import { PrismaClient } from "@prisma/client";
import { createApp } from "./app.js";
import { config } from "./config.js";

const prisma = new PrismaClient();
const server = createApp(prisma).listen(config.port, () => {
  console.log(`listening on http://localhost:${config.port}`);
});

/** How long in-flight requests get to finish before we stop being polite. */
const SHUTDOWN_GRACE_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received, draining connections`);

  // A single hung keep-alive connection should not keep the pod alive forever.
  const forceExit = setTimeout(() => {
    console.error("Grace period elapsed, exiting immediately");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
