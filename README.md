# URL Shortener with Real-Time Analytics

A URL shortener built phase by phase, each phase introducing one piece of
distributed-systems machinery and the reasoning behind it. **All 14 phases are implemented.** Phases 0–8 and 11–13 are verified by running
them; 9 and 10 (Kubernetes) are schema-validated only, because no cluster was
available — that gap is stated wherever it matters rather than papered over.

- Node 22 · TypeScript (strict) · Express
- PostgreSQL via Prisma
- Redis for cache-aside reads and sliding-window rate limiting
- Structured JSON logging via pino, with per-request correlation ids
- Kafka (KRaft) for the durable click-event log
- A small HTML console at `/` so the whole pipeline is visible, not just curl-able
- Docker Compose for local infrastructure
- 136 tests on `node:test`, no test framework dependency
- Prometheus + Grafana, k6 load tests, GitHub Actions CI

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

## Demo (local)

```bash
docker compose --profile app up -d     # whole system: 8 containers
npm run demo                           # seed links and clicks
```

| | |
| --- | --- |
| **http://localhost:3000** | Console — create a link, follow it, watch trending update live |
| **http://localhost:3001** | Grafana — latency, cache hit rate, event loop lag |
| http://localhost:9090 | Prometheus, if the alert rules come up |

The console is one self-contained HTML file served by `GET /`. It creates
links, lists recent ones with their click counts, and subscribes to `/live` for
the trending board — so a click in one browser tab visibly moves the ranking in
another. That is the whole pipeline made visible: redirect → Kafka → consumer →
Postgres → Redis sorted set → WebSocket.

`npm run demo` exists because an empty leaderboard makes a working system look
broken, and typing curl commands while someone watches is a poor use of their
attention. It seeds six links with an uneven click distribution so the ranking
is real rather than a row of ones.

The API port is fixed at 3000 rather than a range, because "which port is it on
today" is a bad question to answer in front of an audience. Scaling for load
tests overrides it — see `docker-compose.loadtest.yml`.

## Two ways to run it

This system has two shapes, selected by `APP_PROFILE`, and they share one
codebase — the difference is which dependencies get wired in at startup, not
which code exists.

| | `full` | `minimal` |
| --- | --- | --- |
| Where | Docker Compose, or containers on a real host | Vercel / any serverless platform |
| Storage | Postgres + replica | Postgres |
| Cache, rate limiting, trending | Redis | none |
| Click analytics | Kafka + consumer | none |
| Live leaderboard | WebSocket | none |
| What works | everything | create a link, follow a link |

**Why the split is not laziness.** A serverless function wakes up, answers one
request, and is frozen or discarded. There is nowhere to keep a Redis
connection pooled, a WebSocket open, a 2-second timer ticking, or a Kafka
consumer running — those need a process that stays alive between requests.
The minimal profile is the part of this system that genuinely fits that model.

## Deploying the minimal profile

### 1. Postgres on Supabase

Create a project, then take **both** connection strings from
Project Settings → Database:

- **Transaction pooler**, port 6543 → `DATABASE_URL`, with
  `?pgbouncer=true&connection_limit=1` appended
- **Direct connection**, port 5432 → `DIRECT_DATABASE_URL`

Two URLs because serverless functions open a connection per instance, so the
app must go through the pooler or Postgres runs out of connections long before
traffic gets interesting. Migrations must *not*: they issue DDL and advisory
locks, neither of which survives a transaction-mode pooler.

Run the migrations from your own machine:

```bash
DATABASE_URL="<pooled>" DIRECT_DATABASE_URL="<direct>" npx prisma migrate deploy
```

### 2. Vercel

Import the repository, framework preset **Other**, and set:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the pooled Supabase URL |
| `DIRECT_DATABASE_URL` | the direct Supabase URL |
| `APP_PROFILE` | `minimal` |
| `TRUST_PROXY` | `true` |
| `CREATE_API_KEY` | a long random string |

`TRUST_PROXY` matters: without it Express reads the scheme as `http` behind
Vercel's proxy and hands back `http://` short URLs on an HTTPS site.

`CREATE_API_KEY` is the one that matters more. Without it anyone can create
links on your domain, and an open shortener gets found by scanners and used to
launder phishing links behind whatever reputation your domain has. With it,
creation needs the header and redirects stay public — which is the correct
split, because the entire point of a short link is that anyone can follow it.

```bash
curl -X POST https://your-app.vercel.app/links   -H "Content-Type: application/json"   -H "X-API-Key: <your key>"   -d '{"longUrl":"https://example.com/a/very/long/url"}'
```

Then open the `shortUrl` it returns.

### How the routing works

Every path has to reach one function, so `vercel.json` rewrites `/(.*)` to
`/api?__path=$1` and the handler puts the original path back before Express
routes on it. Passing the path explicitly rather than relying on how a platform
happens to present `req.url` after a rewrite is deliberate: if that were wrong,
every short code would resolve to the same route and the whole service would
404. `normalizeRequestUrl` has its own unit tests for exactly that reason.

**Verified locally, not on Vercel.** The handler was driven directly with the
rewrite's URL shape (`/api?__path=<code>`) and creates, redirects, 404s and
health checks all behave. The Vercel build itself is unverified — deploying
needs an account this environment does not have.

## API

| Method | Path      | Behaviour |
| ------ | --------- | --------- |
| `GET`  | `/`       | The demo console (HTML). |
| `GET`  | `/links`  | Recent links with click counts. Requires `X-API-Key` when `CREATE_API_KEY` is set. |
| `GET`  | `/health` | Liveness. Always `200` while the process is up; never touches Postgres. |
| `GET`  | `/ready`  | Readiness. `200` when Postgres answers, `503` when it does not. Redis being down does **not** fail this. |
| `POST` | `/links`  | `201` with the created link. Requires `X-API-Key` when `CREATE_API_KEY` is set. `400` on an invalid `longUrl`, `413` on an oversized body. |
| `GET`  | `/links/:code/stats` | Click count and unique visitors for one link. |
| `GET`  | `/trending` | Top links over the trailing window. *(full profile only)* |
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

## Phases 9 and 10 — Kubernetes and autoscaling

```bash
npm run k8s:render      # kustomize build
npm run k8s:validate    # strict schema validation, offline
```

> **Verification status, stated plainly.** There is no cluster in this
> environment — minikube and kind are not installed and `kubectl` has no
> context. These manifests are **schema-validated, not cluster-tested**: all 11
> rendered resources pass `kubeconform -strict` against Kubernetes 1.30, and
> `kustomize build` renders cleanly. That catches typos, wrong API versions and
> misspelled fields. It does **not** prove the pods schedule, the probes pass,
> or the HPA scales. Everything below is reasoning, not a measurement, and it
> is the one part of this project that has not been run.

### The probe split, again

The liveness/readiness distinction from Phase 0 is what these manifests exist
to exploit. Liveness hits `/health` and never touches Postgres: if it did, a
database blip would fail every pod's liveness probe simultaneously and
Kubernetes would restart the entire fleet, turning a recoverable outage into a
crash loop. Readiness hits `/ready`, so a pod that cannot serve leaves the
Service without being killed.

A `startupProbe` covers slow starts separately, because otherwise a cold start
longer than the liveness threshold is an infinite restart loop.

### Shutdown is a race, and `preStop` is the fix

Removing a pod from the endpoints list and sending it SIGTERM happen
concurrently, and proxies learn about the removal asynchronously. Without the
five-second `preStop` sleep, a pod can stop accepting connections before every
proxy knows it is going — which is what deploy-time 502s usually are. The grace
period is 30s against the app's own 10s drain, so a slow drain finishes instead
of being SIGKILLed halfway.

### The consumer does not autoscale, and that is the point

A Kafka partition is consumed by at most one member of a consumer group. With
three partitions, a fourth consumer replica does nothing but join the group,
sit idle, and force a rebalance whenever it starts or stops. Its ceiling is a
property of the topic, not of load — and raising it means repartitioning, which
rehashes keys and breaks the per-link ordering Phase 4 established.

So the consumer is a fixed two replicas with no HPA. It also has no probes: it
listens on nothing, and a fake HTTP endpoint added to satisfy a probe would
report healthy while the consumer sat wedged. A real liveness signal here is
consumer-group membership or lag.

### HPA choices

- **CPU at 70% of request.** Utilisation is a percentage of the *request*, so
  an unset request means no CPU-based autoscaling at all — that is why the
  requests are set deliberately rather than as boilerplate.
- **No CPU limit.** A CPU limit throttles a Node event loop in ways that look
  exactly like a slow dependency; the request already guarantees a floor.
- **`maxReplicas: 12`.** The API is stateless and would scale further, but each
  replica opens Postgres and Redis connections, so the real ceiling is the
  database connection limit. Past this the answer is PgBouncer, not more pods.
- **Scale up instantly, scale down over five minutes.** An overloaded redirect
  service is a down redirect service. Flapping costs more in cold caches and
  connection churn than idle pods save.

A `PodDisruptionBudget` keeps 2 of 3 replicas during node drains and upgrades,
which are otherwise free to evict everything at once.

### Migrations and partitions

Migrations run as a `Job` from the build-stage image, since the Prisma CLI is a
devDependency absent from the runtime image. Partition maintenance is a monthly
`CronJob` — provisioning ahead is what keeps the Phase 7 default partition
empty, and a non-empty default makes creating that month's partition fail.

---

## Phase 11 — load testing until it breaks

```bash
docker compose -f docker-compose.yml -f docker-compose.loadtest.yml --profile app up -d
npm run loadtest        # ramp until the thresholds break
```

Rate limits are raised for these runs. The limiter has its own tests; leaving
it at production values would flatten every run at 10 req/s and measure the
limiter rather than the system behind it.

### Where it breaks

Arrival rate held steady at each step, `p95 < 200ms` as the SLO:

| Rate | 1 replica | 3 replicas |
| ---: | ---: | ---: |
| 200/s | **12 ms** | — |
| 400/s | 121 ms | **15 ms** |
| 600/s | 451 ms | **29 ms** |
| 800/s | 646 ms | — |
| 1000/s | — | **144 ms** |
| 1600/s | — | 438 ms |

**One replica holds about 400 req/s. Three hold about 1100.** That is close to
linear, which is the answer you want for a stateless service and the thing that
justifies the HPA in Phase 10.

Errors stayed at 0.00% throughout. The service does not fall over under
overload, it queues — latency degrades long before anything fails, and the
`p99` blows out to tens of seconds while the `p95` still looks survivable.
That gap is the interesting part: an SLO written on averages, or even on p95,
would have called 800 req/s healthy.

### What actually saturates

`docker stats` during a 1200 req/s run, three replicas:

```
url-shortener-api-1   101.92%
url-shortener-api-2   105.06%
url-shortener-api-3   101.81%
shortener-redis        45.48%
shortener-postgres     ~20%
```

Every API replica is pinned at one core; Redis and Postgres are barely
working. **The bottleneck is Node being single-threaded** — one process uses
one core no matter how many the host has. That is why the fix is more replicas
rather than a bigger machine, and it is worth knowing *before* someone
suggests vertical scaling.

It also means the caching work is doing its job: at 400 req/s per replica,
Postgres is close to idle because nearly every redirect is served from Redis.

### Methodology, and its limits

An arrival-rate executor rather than a fixed number of VUs. With VUs, a
slowing system quietly issues fewer requests and hides its own breaking point;
arrival rate holds the offered load constant and lets the queue grow, which is
what actually happens in production.

**The honest caveat:** the load generator runs on the same machine as the
system under test, and k6 itself used ~78% of a core. Contention is real and
these numbers are a lower bound. The *shape* — linear scaling, CPU-bound at one
core per process, zero errors under overload — is trustworthy; the absolute
figures would need a separate load-generating host to defend.

---

## Phase 12 — Prometheus, Grafana, and alerts

```bash
docker compose --profile app up -d
# Grafana    http://localhost:3001   (dashboard auto-provisioned)
# Prometheus http://localhost:9090
```

### The one line that matters most

```ts
function routeLabel(req: Request): string { ... }   // "/:code", never "/0EjtcvP"
```

Labelling a metric with the request path would mint a new time series per short
link. A million links means a million series, which is how people take down
their own Prometheus. The label is the *route pattern*. There is a test
asserting the code never appears as a label value, and the live label set is
exactly `["/:code", "/health", "/links"]`.

### Metrics chosen from what the load test found

Phase 11 established that the bottleneck is a single saturated core, so the
instrumentation is built around detecting that rather than around whatever a
library exports by default:

| Metric | Why |
| --- | --- |
| `nodejs_eventloop_lag_seconds` | The direct symptom of a CPU-bound Node process. Rises *before* latency does. |
| `http_request_duration_seconds` | Histogram bucketed around the 200ms SLO, not around library defaults, so it has resolution where decisions are made |
| `redirect_cache_outcomes_total` | hit / miss / coalesced. A falling hit rate means Postgres is taking read traffic the cache exists to absorb |
| `rate_limit_rejections_total` | Distinguishes "we are being attacked" from "we are broken" |
| `click_events_dropped_total` | Analytics loss, which is invisible from the redirect path by design |

### Alerts

Five rules, and the primary one is latency rather than errors — because Phase
11 measured that this service *queues* rather than failing. Error rate stayed
at 0.00% while p99 blew out to tens of seconds. An alert on errors alone would
have stayed silent through the entire overload.

`EventLoopLagHigh` carries the remedy in its annotation: Node is
single-threaded, so add replicas rather than a bigger machine.

### Verified

Not just "the config exists":

- Prometheus discovers all three API replicas via DNS service discovery, so
  `--scale api=3` is picked up automatically — a static target would scrape one
  replica and silently miss the rest. All targets `up`.
- All five alert rules load (`promtool check rules`, and the live rules API).
- Grafana provisions the datasource and the eight-panel dashboard on startup.
- Under a 300 req/s run: 11,802 cache hits, 11,854 redirects, p95 21.6 ms,
  event loop lag ~3 ms across three instances.

Grafana runs with anonymous admin and no login form. That is a local-development
convenience and is called out here because it is exactly the kind of thing that
should never reach a real deployment.

---

## Phase 13 — CI/CD

Five jobs, split so failures arrive in order of how fast they can be known.

| Job | What it does |
| --- | --- |
| `static` | Typecheck and unit tests. No containers, ~1 minute. |
| `integration` | Brings up Postgres + replica + Redis + Kafka via the same Compose file used locally, migrates, runs the integration suite. |
| `image` | Builds the runtime image with a GitHub Actions layer cache. |
| `manifests` | Renders kustomize and validates with `kubeconform -strict`. |
| `publish` | Builds and pushes to GHCR. Gated — see below. |

### Reusing the Compose file rather than `services:`

GitHub's `services:` block is the obvious choice and the wrong one here. Kafka
needs two listeners with different advertised addresses, and the replica needs
a `pg_basebackup` init step — neither fits that block. More importantly,
expressing the topology twice lets CI and local development drift apart, and
the first symptom of that drift is a test that passes locally and fails in CI
for reasons nobody can reproduce.

### Publishing is opt-in on purpose

The `publish` job is gated on `vars.PUBLISH_IMAGE == 'true'` as well as on
`main`. Pushing a package into someone's registry is a side effect that should
be chosen, not something a workflow quietly starts doing the moment it merges.
Turn it on with:

```bash
gh variable set PUBLISH_IMAGE --body true
```

### Also here

`concurrency` with `cancel-in-progress`, so a newer push abandons the run it
supersedes. Every job has a `timeout-minutes`, because the default is six hours
and a hung job otherwise burns a runner for an afternoon. On failure the
integration job dumps container logs, since "it failed in CI" is useless
without them. Dependabot groups minor and patch updates into one PR and leaves
majors individual, because those need reading rather than merging.

---

## Known limitations

Deliberately unaddressed at this phase, and the honest answers if asked:

- **Rate limits are per-IP**, so a botnet or a shared NAT both defeat them in
  opposite ways. Per-account limits need accounts.
- **No auth.** Links are anonymous and permanent; there is no way to list, edit,
  revoke, or expire one.
- **Single-flight is per-process**, as discussed above.
- **Click counts can over-count** after a consumer crash, because delivery is
  at-least-once with no dedup key.
- **Single instance.** No connection-pool tuning.
- **The multiplier is not secret**, as discussed above.
- **The Kubernetes manifests have never run on a cluster.** No cluster was
  available; they are schema-valid and no more than that.
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
- [x] **Phase 9** — Kubernetes manifests *(schema-validated, not cluster-tested)*
- [x] **Phase 10** — Horizontal Pod Autoscaler *(schema-validated, not cluster-tested)*
- [x] **Phase 11** — Load test with k6 until it breaks
- [x] **Phase 12** — Prometheus + Grafana + structured logs
- [x] **Phase 13** — CI/CD with GitHub Actions
