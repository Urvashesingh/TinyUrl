import pino from "pino";
import { config } from "./config.js";

// JSON to stdout, one object per line. Nothing here knows or cares where the
// logs end up: the platform collects stdout. That is the whole 12-factor
// argument, and it is why there is no file path or rotation config.
export const logger = pino({
  level: config.logLevel,
  base: { service: "url-shortener" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Ship the level as "info" rather than 30, so log search is readable.
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;
