import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";
import type { Request, RequestHandler, Response } from "express";

export const registry = new Registry();

// Node's own metrics, including nodejs_eventloop_lag_seconds -- which is the
// single most useful number here, because Phase 11 showed the bottleneck is
// one saturated core rather than any downstream dependency. Event loop lag is
// what that looks like from inside the process.
collectDefaultMetrics({ register: registry, prefix: "shortener_node_" });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  // Bucketed around the SLO from Phase 11 (p95 < 200ms) rather than around
  // Prometheus defaults, so the histogram has resolution where decisions get
  // made instead of where the library guessed.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const redirectCacheOutcomes = new Counter({
  name: "redirect_cache_outcomes_total",
  help: "Redirect lookups by where the answer came from",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const rateLimitRejections = new Counter({
  name: "rate_limit_rejections_total",
  help: "Requests refused by a rate limiter",
  labelNames: ["limiter"] as const,
  registers: [registry],
});

export const clickEventsDropped = new Counter({
  name: "click_events_dropped_total",
  help: "Click events that could not be published",
  registers: [registry],
});

export const linksCreated = new Counter({
  name: "links_created_total",
  help: "Short links created",
  registers: [registry],
});

/**
 * The route *pattern*, never the actual path.
 *
 * Labelling with req.path would mint a new time series per short code. A
 * million links would mean a million series, which is how people take down
 * their own Prometheus. This is the single most important line in the file.
 */
function routeLabel(req: Request): string {
  const route = (req.route as { path?: string } | undefined)?.path;
  if (route) {
    return (req.baseUrl || "") + route;
  }

  // Unmatched requests share one bucket rather than each inventing a series.
  return "unmatched";
}

export function metricsMiddleware(): RequestHandler {
  return function measure(req, res, next) {
    // The metrics endpoint measuring itself is noise.
    if (req.path === "/metrics") {
      return next();
    }

    const stop = httpRequestDuration.startTimer();

    res.on("finish", () => {
      stop({
        method: req.method,
        route: routeLabel(req),
        status: String(res.statusCode),
      });
    });

    return next();
  };
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
}
