# URL Shortener with Real-Time Analytics

A URL shortener built phase by phase, each phase introducing one piece of
distributed-systems machinery and the reasoning behind it. **Phases 0 through 2 are
complete and tested.**

- Node 22 · TypeScript (strict) · Express
- PostgreSQL via Prisma
- Redis for cache-aside reads and sliding-window rate limiting
- Structured JSON logging via pino, with per-request correlation ids
- Docker Compose for local infrastructure
- 58 tests on `node:test`, no test framework dependency

## Quick start

```bash
docker compose up -d          # Postgres + Redis
cp .env.example .env
npm install
npx prisma migrate dev
npm run dev                   # http://localhost:3000
```

```bash
npm test                      # unit + integration
npm run typecheck             # strict tsc over src and test
npm run build && npm start    # compiled
```

`npm test` expects the Compose Postgres and Redis to be up; the integration
suite drives a real HTTP server against both and cleans up what it creates.
`npm run test:unit` needs neither and runs in about a second.

## API

| Method | Path      | Behaviour |
| ------ | --------- | --------- |
| `GET`  | `/health` | Liveness. Always `200` while the process is up; never touches Postgres. |
| `GET`  | `/ready`  | Readiness. `200` when Postgres answers, `503` when it does not. Redis being down does **not** fail this. |
| `POST` | `/links`  | `201` with the created link. `400` on an invalid `longUrl`, `413` on an oversized body. |
| `GET`  | `/:code`  | `302` to the stored URL with `Cache-Control: no-store`. `404` if unknown. |

```bash
curl -X POST localhost:3000/links \
  -H 'Content-Type: application/json' \
  -d '{"longUrl":"https://example.com/some/long/path"}'
```

```json
{
  "code": "0EjtcvP",
  "longUrl": "https://example.com/some/long/path",
  "shortUrl": "http://localhost:3000/0EjtcvP",
  "createdAt": "2026-08-28T10:57:57.491Z"
}
```

## Layout

```
src/config.ts   environment parsing, validated once at startup
src/logger.ts   pino instance, JSON to stdout
src/base62.ts   base62 codec over bigint
src/codes.ts    id <-> code, the permutation that makes codes unguessable
src/cache.ts    Redis client and the cache contract, fail-soft throughout
src/links.ts    cache-aside read path, single-flight coalescing
src/app.ts      createApp(prisma, cache) -> Express app, no side effects
src/index.ts    listen, signal handling, graceful shutdown
test/           unit tests for codec and resolver, integration tests for API and cache
```

`createApp` takes its dependencies as arguments rather than importing
singletons. That is what lets the integration suite start the app on an
ephemeral port without the module also deciding to bind port 3000 as a side
effect, and what lets the resolver be unit-tested against fakes with exact
"how many times did we touch the database" assertions.

---

## Design notes

### Short codes are a pure function of the primary key

Postgres already hands out unique integers, so the id is the only source of
uniqueness needed. `code = base62(id)` gives short unique codes with no
collision checks, no retry loop, and no second uniqueness authority to keep in
sync.

Encoding the id *directly*, though, publishes two things: how many links exist,
and where the next one will be. Anyone can walk the entire table by counting.
So the id is first pushed through a multiplicative permutation of the code
space:

```
code = base62((id * M) mod 62^7)     M coprime with 62^7
```

Multiplying by a value coprime with the modulus is a bijection, so distinct ids
still map to distinct codes — the collision-free property survives intact — but
consecutive ids now land far apart. Padding to a fixed 7 characters hides the
magnitude of the id as well, and gives a uniform 3.5-trillion-entry space.

Because the permutation is invertible, `decodeCode` recovers the id, which earns
its keep on the read path: a code that is the wrong length or contains
characters outside the alphabet provably was never issued, so `GET /:code`
rejects it before spending a database round trip. A scanner hammering random
paths costs us almost nothing.

**Worth being honest about in an interview:** this is obfuscation, not
encryption. The multiplier is in the source. Anyone who recovers it can
enumerate again. It raises the cost of casual scraping; it is not access
control, and nothing private should sit behind a short link on the strength of
it. The stronger version is a keyed Feistel network over the same space, which
buys a real pseudorandom permutation for the same fixed cost.

### Creation is a single atomic INSERT

The obvious implementation of "code depends on the id" is insert, read the id
back, then update the row with the code. That is two statements with a window
between them: crash in the middle and you have a permanently unreachable row
holding a placeholder code.

Instead the id is reserved from the sequence first:

```sql
SELECT nextval(pg_get_serial_sequence('links', 'id'));
```

The code is computed from that value, and the row is written once, complete. No
transaction needed, no placeholder state, half the round trips. Sequences are
non-transactional by design, so a failed request burns an id — gaps are the
intended trade and cost nothing, because the id is no longer publicly meaningful
anyway.

### Duplicate long URLs get distinct codes

Deduplicating would mean a lookup before every insert, an index on a 2 KB column
to support it, and a shared row whose analytics belong to several unrelated
campaigns at once. Each short code is independent instead, which is also what
makes Phase 3's per-link click stream meaningful.

### 302, and `Cache-Control: no-store`

A `301` is permanent: browsers and proxies cache it aggressively and stop asking
us, which is fast and free right up until the analytics phase, when those
uncounted clicks are the entire product. `302` plus `no-store` guarantees every
click reaches the service. If a link ever needs to be editable or revocable, the
same choice is what makes that possible.

### Liveness and readiness are different questions

`/health` answers "is this process alive" and deliberately does not check
Postgres — if it did, a brief database blip would fail the liveness probe and
Kubernetes would restart every healthy pod in the fleet, turning a recoverable
outage into a crash loop. `/ready` answers "should this instance receive
traffic" and does check, so a struggling instance is pulled from the load
balancer without being killed.

### Input handling

Only `http:` and `https:` are accepted — otherwise the redirect becomes a
delivery mechanism for `javascript:` and `data:` payloads aimed at whoever
trusts the short domain. URLs are capped at 2048 characters and bodies at 4 KB,
because `TEXT` is unbounded and nothing here needs to be large. Body-parser
rejections are mapped to the caller's `4xx` rather than being swallowed as a
`500`.

`shortUrl` is built from `BASE_URL` when set, falling back to the `Host` header
otherwise. Host is attacker-controlled, so in production that variable should be
set — the fallback is a local-development convenience, not the intended path.

### Shutdown

`SIGTERM` stops the listener, drains in-flight requests, disconnects Prisma, and
exits — with a 10-second cap, because one hung keep-alive connection should not
be able to outlast the orchestrator's patience and turn a rolling deploy into a
forced kill.

---

## Phase 1 — caching and observability

### Cache-aside, not write-through

Reads check Redis, fall back to Postgres on a miss, and populate the cache on
the way back out. Writes do not touch the cache at all.

Write-through would be the obvious alternative, but most created links are never
clicked — a link is shared, or it is not. Populating on write fills memory with
entries nobody asks for. Populating on read means only links people actually
follow occupy cache, which is the working set you wanted in the first place.

### Misses are cached too

Caching only successes leaves an obvious hole: anyone walking the code space
gets a guaranteed Postgres read on every request, so the cache protects the
database from exactly the traffic that is not trying to hurt it, and not at all
from the traffic that is.

So a "no such code" answer is cached as a sentinel, on a much shorter TTL — 30
seconds against an hour. The asymmetry is the point: a cached link is immutable
and can sit there safely, whereas a cached absence is a claim about something
that becomes false the moment that code is created.

Cheap first line of defence, unchanged from Phase 0: a code that fails
`decodeCode` was provably never issued, so it is rejected before either Redis or
Postgres is consulted.

### A cold hot key does not stampede the database

If a link goes viral while its cache entry is cold, every concurrent request
misses and every one of them queries Postgres for the same row. The read path
keeps a map of in-flight lookups, so concurrent requests for the same code wait
on the first read rather than issuing their own. The test asserts 20 concurrent
requests produce exactly one database read.

The honest caveat is that this is per-process: with N instances a cold key still
costs N reads rather than one. The cross-instance fix is a distributed lock,
whose failure modes cost more than they save at this scale.

### Redis is an optimization, never a dependency

The failure that matters is not "Redis is slow", it is "Redis is gone". Two
client settings decide what happens then:

```
enableOfflineQueue: false     do not park commands waiting for reconnect
maxRetriesPerRequest: 1       do not spend the caller's latency retrying
```

Without them an outage turns into every request *hanging* rather than every
request getting slower — strictly worse, because hung requests exhaust
connections and take the service down with the cache. With them, commands fail
instantly, every cache operation is wrapped so a failure degrades to a miss, and
traffic reads through to Postgres.

Verified by stopping the container mid-traffic: redirects kept returning `302`
in ~13 ms, creation kept working, and the cache repopulated on reconnect. The
error log is rate-limited to one line per 10 seconds, because ioredis retries
continuously and the alternative is thousands of identical lines burying the
incident.

`/ready` deliberately does not check Redis. If it did, a Redis outage would pull
every healthy instance out of the load balancer simultaneously — turning a
degraded service into no service at all.

### Invalidation, and why there is none yet

Links are immutable, so a cached entry can never be wrong and the TTL is purely
a memory bound. This stops being true the moment links become editable or
revocable: TTL alone would mean serving a revoked link for up to an hour. That
feature needs an explicit `DEL` on write, and the write and the delete are not
atomic, so the ordering matters — delete after commit, and accept that a crash
in between leaves a stale entry until it expires.

The key prefix is versioned (`link:v1:`) so a change to the stored shape can be
rolled out by bumping the prefix rather than trying to migrate live keys.

### Logging

JSON to stdout, one object per line, no file paths or rotation — the platform
collects stdout. Every line inside a request carries a `reqId`, taken from an
inbound `X-Request-Id` when present so a trace survives across services, and
minted otherwise. It is echoed back on the response, so a user reporting a
problem can hand you the exact id.

Redirects log their cache outcome (`hit` / `miss` / `coalesced`), which makes
hit rate greppable before there is a metrics stack. Health and readiness probes
are excluded from request logging — they fire constantly and would bury
everything else. Real counters are Phase 12.

Redis itself is configured as a pure cache in Compose: `--save ""` (no
snapshots, the data is derived), a `maxmemory` ceiling so it cannot starve the
host, and `allkeys-lru` so it evicts cold keys instead of erroring on OOM.

---

## Phase 2 — rate limiting

### Sliding window log, in one atomic script

Each caller gets a Redis sorted set of request timestamps. A check drops
entries older than the window, counts what remains, and admits the request if
that count is under the limit.

The alternatives and why not:

| Algorithm | Why not |
| --- | --- |
| Fixed window | Allows 2x the limit across a boundary — spend a full quota at 11:59:59 and another at 12:00:00 |
| Token bucket | Allows deliberate bursts, which is a feature for a paid API and a bug for abuse control |
| Sliding log | Exact, and memory is bounded by the limit itself — a few dozen bytes per caller at these limits |

The whole read-modify-write runs as one Lua script, so it is atomic. Doing it
with separate `ZCARD` and `ZADD` calls leaves a race where concurrent requests
all observe the same under-limit count and all get admitted — precisely the
burst the limiter exists to stop. A test fires 40 concurrent requests at a
limit of 5 and asserts exactly 5 get through.

### Two budgets, not one

Creation is capped hard (20/min): it writes a row and mints a permanent public
identifier. Redirects are capped loosely (600/min) — that ceiling exists to
blunt scanners, not to ration real traffic. They are separate key namespaces,
so a burst of creates cannot exhaust the budget that redirects depend on.
There is a test for exactly that, because sharing a key here is an easy and
very damaging mistake.

### Failing open, deliberately

If Redis is unreachable the limiter admits the request and logs a warning. The
trade is explicit: for the duration of an outage there is no rate limiting at
all. Failing closed would convert a cache outage into a total outage, which is
strictly worse — and the limiter exists to protect against abuse, not to be a
availability dependency of the thing it protects.

The same startup caveat applies: a burst arriving in the few milliseconds
before the Redis connection is ready is unlimited.

### Limits are per-IP, which is a real weakness

`req.ip` is the identity, honoured through `trust proxy`. That is fine against
casual abuse and useless against a botnet or a shared NAT — the former gets a
fresh budget per address, the latter shares one budget among unrelated users.
The real answer is per-account limits once there are accounts, with IP limits
as the outer bound.

---

## Known limitations

Deliberately unaddressed at this phase, and the honest answers if asked:

- **Rate limits are per-IP**, so a botnet or a shared NAT both defeat them in
  opposite ways. Per-account limits need accounts.
- **No auth.** Links are anonymous and permanent; there is no way to list, edit,
  revoke, or expire one.
- **Single-flight is per-process**, as discussed above.
- **No cache metrics.** Hit rate is greppable from logs, not measurable. Phase 12.
- **Single instance.** No connection-pool tuning, no read replica.
- **The multiplier is not secret**, as discussed above.
- **`npm audit` reports 3 high advisories** in `deepmerge-ts`, reached only
  through the `prisma` CLI devDependency. No patched version is in range and it
  is not runtime code, so it is tracked rather than force-upgraded.

## Phase tracker

- [x] **Phase 0** — Core API: create short link + redirect
- [x] **Phase 1** — Redis cache (cache-aside) + structured logging
- [x] **Phase 2** — Rate limiter (Redis)
- [ ] **Phase 3** — Redirect events via Redis pub/sub
- [ ] **Phase 4** — Swap pub/sub for Kafka/RabbitMQ
- [ ] **Phase 5** — Live trending leaderboard (WebSockets + Redis sorted sets)
- [ ] **Phase 6** — Postgres read replica + read/write split
- [ ] **Phase 7** — Partition the click-events table
- [ ] **Phase 8** — Dockerize all services + compose
- [ ] **Phase 9** — Kubernetes (minikube)
- [ ] **Phase 10** — Horizontal Pod Autoscaler
- [ ] **Phase 11** — Load test with k6 until it breaks
- [ ] **Phase 12** — Prometheus + Grafana + structured logs
- [ ] **Phase 13** — CI/CD with GitHub Actions
