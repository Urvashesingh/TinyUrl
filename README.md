# URL Shortener with Real-Time Analytics

A URL shortener built phase by phase, each phase introducing one piece of
distributed-systems machinery and the reasoning behind it. **Phases 0 through 8 are
complete and tested.**

- Node 22 · TypeScript (strict) · Express
- PostgreSQL via Prisma
- Redis for cache-aside reads and sliding-window rate limiting
- Structured JSON logging via pino, with per-request correlation ids
- Kafka (KRaft) for the durable click-event log
- Docker Compose for local infrastructure
- 108 tests on `node:test`, no test framework dependency

## Quick start

```bash
docker compose up -d          # Postgres (+replica), Redis, Kafka
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
| `GET`  | `/links/:code/stats` | Click count and unique visitors for one link. |
| `GET`  | `/trending` | Top links over the trailing window. |
| `WS`   | `/live`   | Pushes the trending board as it changes. |
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

## Phase 3 — click events over Redis pub/sub

### The redirect never waits on analytics

`publishClick` returns `void`, not a promise. That is deliberate: a signature
that returns a promise invites a caller to await it, and the moment a redirect
awaits analytics, an analytics problem becomes a user-facing latency problem.
The publish is fired and forgotten, and its failure path is a counter, not an
exception.

### A separate consumer process

The consumer subscribes, buffers, and writes batches to Postgres. It runs as
its own process because the two halves have opposite requirements: the API is
latency-critical and scales with request volume, the consumer is
throughput-oriented and scales with event volume. Sharing a process lets a slow
batch insert compete with a redirect for the same event loop.

Batching is triggered by size *or* by time, because either alone is wrong:
size-only strands the last few events when traffic goes quiet, time-only gives
up throughput under load. Flushes are serialised so two cannot interleave, and
a failed batch is logged and dropped rather than retried in place — retrying
would grow the buffer without bound during an outage, trading lost analytics
for a dead process.

### Addresses are hashed, never stored

`ipHash` is a salted SHA-256 truncated to 32 characters. The salt matters: an
*unsalted* hash of an IPv4 address is trivially reversible, because the entire
space is only 2^32 and fits in a rainbow table. Salted, it is enough to count
unique visitors and not enough to identify one.

### This phase loses data, on purpose

Redis pub/sub is at-most-once and has no storage. If no subscriber is connected
the message is dropped on the floor — no queue, no replay, no acknowledgement.

Demonstrated rather than assumed: with the consumer stopped, four redirects
were served successfully and all four clicks were lost permanently.

```
consumer down -> 4 redirects served (302, 302, 302, 302)
clicks recorded: 5   (unchanged -- the 4 are gone for good)
```

That means every deploy of the consumer silently drops whatever arrives during
the restart. It is an acceptable trade for a view counter and completely
unacceptable for anything that bills or audits — which is the entire argument
for Phase 4.

---

## Phase 4 — Kafka instead of pub/sub

Same publisher contract, different guarantees. `EVENT_TRANSPORT` selects
`redis` (Phase 3) or `kafka` (default), which is what makes the two directly
comparable.

### What actually changed

Redis pub/sub is a fan-out with no storage: publish into a room with nobody in
it and the message is gone. Kafka is an append-only log — the broker keeps the
event, and each consumer group tracks its own offset into it.

The same experiment, run against both transports:

| | consumer down during 6 clicks | after consumer starts |
| --- | --- | --- |
| Phase 3, Redis pub/sub | redirects served | **clicks lost permanently** |
| Phase 4, Kafka | redirects served | **all 6 replayed and recorded** |

That is the whole phase. Everything else follows from the log being durable.

### Write first, acknowledge second

The consumer uses `eachBatch` with auto-resolve off: it writes the batch to
Postgres, *then* resolves offsets and commits. That ordering is what makes
delivery at-least-once — a crash between the write and the commit replays the
batch, so events can be duplicated but never lost. Committing first inverts the
guarantee and loses them instead.

The honest consequence: **click counts can over-count after a consumer crash.**
Fixing that needs a deduplication key — an event id carried from the publisher
and a unique index — which is a real cost, and for a view counter the trade is
usually not worth paying. For anything that bills or audits, it is.

Rebalances are handled explicitly: if `isRunning()` or `isStale()` goes false
mid-batch the handler returns without committing, because committing would
acknowledge work another group member is about to redo.

### Partitioning by code

Messages are keyed by short code, so every event for one link lands on the same
partition. That buys per-link ordering and lets a consumer aggregate a link's
clicks without coordinating across partitions — which is what Phase 5's
leaderboard depends on. Tested directly: 12 events with one key land on exactly
one partition, and 40 distinct keys spread across several.

Partition count is set explicitly (3) and auto-creation is disabled on the
broker, because an auto-created topic silently takes the broker default of one
partition — and partition count cannot be lowered later, nor raised without
rehashing keys to different partitions and breaking ordering for existing ones.
It also caps consumer parallelism: one partition is read by at most one member
of a group, so three partitions means at most three useful consumer instances.

### Still fire-and-forget

`publishClick` still returns `void`. The producer batches and flushes in the
background, so the redirect never waits on the broker. The difference is only
in what happens afterwards. Shutdown does disconnect the producer, so buffered
batches flush rather than dying with the process.

---

## Phase 5 — live trending leaderboard

`GET /trending` returns the current board; `ws://host/live` pushes it as it
changes.

### One sorted set per minute, not one running total

The obvious implementation is a single sorted set and `ZINCRBY` per click. It
is also wrong: that set never forgets, so a link that went viral last week
outranks everything current, permanently.

Instead there is one sorted set per minute, each with a TTL slightly longer
than the window. "Trending" is a `ZUNIONSTORE` across the buckets still alive.
Old minutes leave the window because Redis has already deleted them — no sweep
job, no cleanup, no unbounded key growth. Sorted sets make both halves cheap:
`O(log N)` to increment, `O(log N + K)` to read the top K.

### Bucketed by when the click happened

A click is filed under `occurredAt`, not under the time the consumer got round
to it. Otherwise a consumer restarting and replaying an hour of Kafka backlog
would pour all of it into the current minute and invent a spike that never
happened. There is a test for exactly that, because Phase 4 made backlog replay
a normal event rather than a rare one.

### Computed once per tick, not once per client

The union is the expensive part. It runs on a timer and the result fans out to
every connected socket from memory, so cost is a function of the refresh
interval rather than of how many people are watching. `GET /trending` serves
that same cached snapshot instead of recomputing.

This is the actual argument for pushing rather than polling: with N clients
polling independently, Redis does N unions per interval. Here it does one.
Server-sent events would serve this equally well — the traffic is entirely
one-directional — but a WebSocket leaves room for the next obvious feature,
subscribing to a single link's live count.

### Slow clients are dropped, not buffered

If a client stops draining its socket, the outbound buffer grows inside our
process until memory runs out. Past a megabyte the socket is terminated. A
leaderboard is worthless when stale, so there is nothing worth queueing for a
client that cannot keep up.

### Failure behaviour

The leaderboard is derived data, so it is never allowed to break anything
upstream. A failed refresh keeps serving the previous snapshot. A failed
`recordClicks` in the consumer is logged and swallowed — it happens *after* the
durable Postgres write, and the counters rebuild as the window rolls forward.
Redis holding a derived counter must never block the system of record.

---

## Phase 6 — read replica and read/write split

A streaming standby is built by cloning the primary on first start
(`pg_basebackup -R`). Writes go to the primary; reads that tolerate staleness
go to the replica.

### The interesting problem is read-your-writes

Replication is asynchronous. Create a link and click it immediately and the
redirect can reach the replica *before* the row does — a 404 for a link that
demonstrably exists, and the user has no way to tell it is temporary.

The usual answers are a synchronous replica (which makes every write wait for
the standby) or routing recent reads to the primary (which needs session
tracking and gives back the load you were trying to shed).

Neither is needed here, because Phase 1 already built the fix. Creation seeds
the cache with the row it just wrote, so a redirect for a brand new link is
served from Redis and never consults the database at all. The lag window is
covered by a cache entry that cannot be stale, because it was written by the
same request that created the row.

### The replica is optional, at every level

`DATABASE_REPLICA_URL` unset means reads go to the primary, with no separate
code path for single-node deployments. When it *is* set and a replica read
fails, the read falls back to the primary — slower and under more load, but
correct. And `/ready` reports replication lag without ever failing on it:
failing readiness for a replica outage would remove capacity for a condition
the service already handles.

### What the split actually buys

Redirect lookups and analytics queries are the overwhelming majority of the
traffic and all of them tolerate a second of staleness. Moving them off the
primary leaves it doing almost nothing but writes. `GET /links/:code/stats`
in particular runs an aggregate over `click_events`, which is exactly the kind
of query you do not want competing with the write path.

The replica physically refuses writes (`cannot execute INSERT in a read-only
transaction`), which is the useful property: a stray write cannot silently
succeed against the wrong node. There is a test asserting it.

### Local caveat

`docker/postgres/10-replication.sh` adds `host replication all all trust` to
the primary's `pg_hba.conf`, because initdb writes no rule for replication and
`pg_basebackup` is refused before it can authenticate. `trust` is a
development convenience — a real deployment uses a dedicated role with the
REPLICATION attribute, scram-sha-256, and a narrower source range.

---

## Phase 7 — partitioning the click-events table

`click_events` is the only table that grows without bound: one row per
redirect, forever. It is now RANGE-partitioned by `occurredAt`, one partition
per month.

### What partitioning actually buys

| | Before | After |
| --- | --- | --- |
| Deleting old data | `DELETE` writes as much WAL as the rows it removes and leaves bloat for VACUUM | `DROP TABLE` on one partition: instant, disk returned immediately |
| "Last 7 days" | Index scan over all history | Only the partitions in range are touched |
| VACUUM / ANALYZE / REINDEX | One enormous relation | Per partition |

Retention is the big one. On a table with a billion rows, `DELETE FROM
click_events WHERE occurredAt < ...` is an outage waiting to happen. Dropping a
partition is a catalogue update.

Pruning is asserted with `EXPLAIN` in the tests rather than assumed: a query
bounded to September must name the September partition and must not mention
July or November.

### The constraint that shapes the design

Postgres requires the partition key to appear in every unique constraint. So
the primary key had to become `(id, "occurredAt")` rather than `id`. That is
not a detail — it is the thing to know before choosing to partition, because it
propagates into every foreign key that would ever point at this table.

### The default partition, and its trap

There is a `DEFAULT` partition, so a row outside every declared range is stored
rather than rejected. Losing a click to a missing partition would be worse than
the trade being made.

The trap: while the default holds rows for a month, creating *that month's*
partition requires scanning the default and **fails** if any row conflicts. So
the default is a safety net, not a working part — `npm run partitions`
provisions three months ahead specifically to keep it empty, and prunes past
the retention horizon in the same pass. It detaches before dropping, so a
long-running query on a partition cannot drag an ACCESS EXCLUSIVE lock onto the
parent.

### Migration notes

Renaming a table renames neither its sequence nor its indexes, and index names
are unique per schema — so the sequence, the primary key, and both indexes all
had to be moved aside before the new table could claim those names. That is the
kind of thing that only shows up when you run the migration, which is why it
was run against a real database rather than reasoned about.

Indexes are declared on the parent, so every current and future partition gets
them automatically. Without that, each new month would quietly start life
unindexed.

---

## Phase 8 — containerising the application

```bash
docker compose up -d                  # infrastructure only (dev workflow)
docker compose --profile app up -d    # everything, including api + consumer
```

The app services sit behind a `app` Compose profile so the default `up`
still starts only infrastructure and the `npm run dev` loop from earlier
phases is unchanged.

### Multi-stage, and what stays behind

The build stage has the full dependency tree, the TypeScript compiler and
Prisma generation. The runtime stage has production dependencies, the compiled
`dist`, and nothing else — 537 MB against 895 MB for the build stage. Most of
what remains is the Prisma query engine and `node_modules`; trimming further
would mean bundling the app and pruning unused engines, which is real work for
a real payoff and has not been done here.

The awkward part is Prisma. `npm ci --omit=dev` would run the `postinstall`
hook, which calls `prisma generate`, which needs the Prisma CLI — a
devDependency deliberately absent from the runtime image. So the runtime
install passes `--ignore-scripts` and the generated client is copied from the
build stage instead.

The second Prisma detail: the container is Alpine (musl) and the host is not,
and Prisma ships a per-platform query engine. Without
`binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` the image builds
cleanly, starts cleanly, and then fails on its first query.

### Migrations are their own service

`migrate` runs `prisma migrate deploy` once and exits; `api` and `consumer`
both `depend_on` it with `condition: service_completed_successfully`, so
nothing serves traffic against a schema that has not been migrated. It builds
from the `build` target, because that is where the Prisma CLI lives.

### Details that matter

- **Non-root.** `USER node`. Running as root inside a container is one escape
  away from root on the host. Verified: `uid=1000(node)`.
- **Layer ordering.** `package*.json` and `prisma/` are copied before `src/`,
  so editing a source file does not invalidate the dependency layer.
- **Healthcheck hits `/health`, not `/ready`** — same reasoning as Kubernetes
  liveness. A database blip must not restart every healthy container.
- **The consumer has no healthcheck and no port.** It serves nothing; an HTTP
  probe would be theatre.
- **`KAFKA_BROKERS: kafka:29092`**, the INTERNAL listener. `localhost:9092`
  only resolves correctly from the host, and using it here is the classic
  "connects, then hangs" failure.

Verified end to end through containers: create, seven redirects, Kafka,
consumer, Postgres, and the trending board all agreeing on seven clicks.

---

## Known limitations

Deliberately unaddressed at this phase, and the honest answers if asked:

- **Rate limits are per-IP**, so a botnet or a shared NAT both defeat them in
  opposite ways. Per-account limits need accounts.
- **No auth.** Links are anonymous and permanent; there is no way to list, edit,
  revoke, or expire one.
- **Single-flight is per-process**, as discussed above.
- **No cache metrics.** Hit rate is greppable from logs, not measurable. Phase 12.
- **Click counts can over-count** after a consumer crash, because delivery is
  at-least-once with no dedup key.
- **Single instance.** No connection-pool tuning.
- **The multiplier is not secret**, as discussed above.
- **`npm audit` reports 3 high advisories** in `deepmerge-ts`, reached only
  through the `prisma` CLI devDependency. No patched version is in range and it
  is not runtime code, so it is tracked rather than force-upgraded.

## Phase tracker

- [x] **Phase 0** — Core API: create short link + redirect
- [x] **Phase 1** — Redis cache (cache-aside) + structured logging
- [x] **Phase 2** — Rate limiter (Redis)
- [x] **Phase 3** — Redirect events via Redis pub/sub
- [x] **Phase 4** — Swap pub/sub for Kafka/RabbitMQ
- [x] **Phase 5** — Live trending leaderboard (WebSockets + Redis sorted sets)
- [x] **Phase 6** — Postgres read replica + read/write split
- [x] **Phase 7** — Partition the click-events table
- [x] **Phase 8** — Dockerize all services + compose
- [ ] **Phase 9** — Kubernetes (minikube)
- [ ] **Phase 10** — Horizontal Pod Autoscaler
- [ ] **Phase 11** — Load test with k6 until it breaks
- [ ] **Phase 12** — Prometheus + Grafana + structured logs
- [ ] **Phase 13** — CI/CD with GitHub Actions
