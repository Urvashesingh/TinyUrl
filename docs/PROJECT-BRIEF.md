# TinyUrl — full project brief

A complete description of this project for study and revision. Paste this whole
file into a chat and ask questions about any part of it.

Repository: https://github.com/Urvashesingh/TinyUrl

---

## 1. What the project is

A URL shortener with real-time click analytics, built in 14 numbered phases
(Phase 0 to Phase 13). Each phase adds one piece of distributed-systems
machinery, and each was chosen to teach a specific trade-off rather than to add
a feature.

**Core product:** you POST a long URL, get back a short code, and following
`/{code}` redirects you. Every redirect is counted, aggregated, and shown on a
live leaderboard.

**Scale of the codebase:** ~2,180 lines of application code (`src/`, `api/`,
`scripts/`), ~1,915 lines of tests across 14 test files, 136 tests total,
20 git commits (one per phase plus fixes).

---

## 2. Request flow (say this out loud in the viva)

**Creating a link**

1. `POST /links` with `{"longUrl": "..."}`
2. Rate limiter checks Redis (sliding window)
3. URL is validated — must be absolute `http:` or `https:`, max 2048 chars
4. An id is reserved from the Postgres sequence: `SELECT nextval(...)`
5. The short code is computed from that id (pure function, no DB lookup)
6. One `INSERT` writes the complete row
7. The new link is written into the Redis cache immediately (cache warming)
8. `201` with the code, long URL, short URL, and creation time

**Following a link**

1. `GET /{code}`
2. The code is decoded mathematically. If it is malformed it provably was never
   issued, so it 404s **without touching Redis or Postgres**
3. Redis is checked (cache-aside)
4. On a miss, Postgres (the read replica) is queried and the result is cached
5. A click event is published to Kafka — **fire and forget, never awaited**
6. `302` redirect with `Cache-Control: no-store`

**Counting the click (asynchronously, separate process)**

1. The consumer reads a batch from Kafka
2. Writes the batch to Postgres (`click_events`)
3. **Then** commits the Kafka offset (this ordering is what makes it
   at-least-once)
4. Increments a Redis sorted set for the current minute
5. A WebSocket pushes the new leaderboard to every connected browser

---

## 3. Technology stack

| Layer | Technology | Version | Why |
| --- | --- | --- | --- |
| Runtime | Node.js | 22 | Native test runner, native fetch, top-level await |
| Language | TypeScript | 5.7, `strict` | Compile-time safety |
| Web framework | Express | 4.21 | Minimal, well understood |
| Database | PostgreSQL | 17 (Alpine) | Transactions, sequences, declarative partitioning |
| ORM | Prisma | 6 | Type-safe queries, migration tooling |
| Cache / counters | Redis | 7 | Sub-ms reads, sorted sets, atomic Lua |
| Redis client | ioredis | 6 | Lua scripting, fine-grained failure control |
| Message log | Apache Kafka | 3.9 (KRaft) | Durable, replayable event log. KRaft = no ZooKeeper |
| Kafka client | kafkajs | 2.2 | Pure JS, no native build step |
| WebSockets | ws | 8 | Live leaderboard push |
| Logging | pino + pino-http | 10 / 11 | Structured JSON logs, low overhead |
| Metrics | prom-client | 15 | Prometheus exposition format |
| Monitoring | Prometheus | 3.1 | Metric storage and alert rules |
| Dashboards | Grafana | 11.5 | Visualisation, provisioned from files |
| Load testing | k6 | latest (Docker) | Arrival-rate load generation |
| Containers | Docker + Compose | — | Local infrastructure and app |
| Orchestration | Kubernetes + kustomize | manifests only | *Not cluster-tested — see §10* |
| CI/CD | GitHub Actions | — | 5 jobs |
| Tests | `node:test` | built-in | 136 tests, zero test-framework dependencies |
| Serverless option | Vercel + Supabase | — | Minimal profile (§9) |

---

## 4. Phase-by-phase, with the reasoning

### Phase 0 — Core API

**Short code generation.** Postgres already produces unique integers, so the
primary key is the only source of uniqueness needed. `code = base62(id)` gives
unique codes with no collision checks and no retry loop.

But encoding the id *directly* leaks two things: how many links exist, and what
the next one will be. Anyone could enumerate the whole table by counting. So the
id is first passed through a **multiplicative permutation**:

```
code = base62((id × M) mod 62^7),  padded to 7 characters
M = 1,500,450,271
62^7 = 3,521,614,606,208  (~3.5 trillion codes)
```

`62^7` factors as `2^7 × 31^7`. `M` is odd and not divisible by 31, so it is
**coprime** with the modulus, which makes multiplication a **bijection** — every
id still maps to a unique code, so the collision-free property survives, but
consecutive ids now land far apart.

Because it is a bijection it is **invertible** (via the modular inverse, found
with the extended Euclidean algorithm). That inverse earns its keep: a code that
is the wrong length or has invalid characters provably was never issued, so a
redirect can 404 it before spending a database round trip. A scanner hammering
random paths costs almost nothing.

> **Be honest about this in the viva:** it is *obfuscation, not encryption*. The
> multiplier is in the source code. Anyone who recovers it can enumerate again.
> The stronger version is a **keyed Feistel network** over the same space, which
> gives a real pseudorandom permutation for the same fixed cost.

**Creation is a single atomic INSERT.** The obvious implementation is: insert
the row, read back the id, then update the row with the code. That is two
statements with a gap between them — crash in the middle and you have a
permanently unreachable row holding a placeholder code. Instead the id is
reserved first:

```sql
SELECT nextval(pg_get_serial_sequence('links', 'id'));
```

The code is computed from that value and the row is written once, complete. No
transaction needed, no placeholder state, half the round trips. Sequences are
non-transactional, so a failed request burns an id — gaps are the intended trade
and cost nothing, because the id is no longer publicly meaningful.

**No deduplication.** Two users shortening the same URL get two different codes.
Deduplicating would need a lookup before every insert, an index on a 2 KB
column, and a shared row whose analytics belong to several unrelated campaigns.

**302, not 301.** A `301` is permanent — browsers and proxies cache it and stop
asking us, which is fast and free right up until analytics matter, when those
uncounted clicks are the entire product. `302` plus `Cache-Control: no-store`
guarantees every click reaches the service.

**Liveness vs readiness.** `/health` says "is this process alive" and
**deliberately does not check Postgres**. If it did, a brief database blip would
fail every pod's liveness probe at once and Kubernetes would restart the whole
fleet, turning a recoverable outage into a crash loop. `/ready` says "should
this instance receive traffic" and does check, so a struggling instance leaves
the load balancer without being killed.

---

### Phase 1 — Redis cache + structured logging

**Cache-aside (lazy loading), not write-through.** Reads check Redis, fall back
to Postgres on a miss, and populate the cache on the way back out. Writes do not
populate it, because most created links are never clicked — write-through would
fill memory with links nobody asks for. Read-through keeps only the real working
set resident.

**Negative caching.** Caching only successes leaves an obvious hole: a scanner
walking the code space gets a guaranteed Postgres read every time, so the cache
protects the database from everything *except* the traffic trying to hurt it.
A "no such code" answer is cached too — but on **30 seconds** against **1 hour**.
The asymmetry matters: a cached link is immutable and safe to hold, but a cached
*absence* becomes false the moment that code is created.

**Single-flight (thundering herd / cache stampede prevention).** If a link goes
viral while its cache entry is cold, every concurrent request misses and all of
them query Postgres for the same row. A `Map` of in-flight lookups makes
concurrent requests for the same code wait on the first one. A test fires 20
concurrent requests and asserts exactly **one** database read.
*Caveat:* it is per-process, so with N instances a cold key still costs N reads.
The cross-instance fix is a distributed lock, whose failure modes cost more than
they save at this scale.

**Redis is an optimisation, never a dependency.** The failure that matters is
not "Redis is slow", it is "Redis is gone". Two client settings decide what
happens:

```
enableOfflineQueue: false     do not park commands waiting for reconnect
maxRetriesPerRequest: 1       do not spend the caller's latency retrying
```

Without them an outage makes every request **hang** rather than get slower —
strictly worse, because hung requests exhaust connections and take the service
down with the cache. **Verified by stopping the container mid-traffic:**
redirects kept returning 302 in ~13 ms and the cache repopulated on reconnect.

Also: the key prefix is versioned (`link:v1:`) so a change to the stored shape
can be rolled out by bumping the prefix instead of migrating live keys.

**Structured logging.** JSON to stdout, one object per line, no file paths or
rotation — the platform collects stdout (12-factor). Every line inside a request
carries a `reqId`, taken from an inbound `X-Request-Id` when present so a trace
survives across services, and minted otherwise. It is echoed on the response, so
a user reporting a problem can hand you the exact id.

---

### Phase 2 — Rate limiting

**Sliding window log**, implemented as a Redis sorted set of request timestamps.
Each check removes entries older than the window, counts what remains, and
admits if under the limit.

| Algorithm | Why not chosen |
| --- | --- |
| Fixed window | Allows 2× the limit across a boundary — a full quota at 11:59:59 and another at 12:00:00 |
| Token bucket | Allows deliberate bursts: a feature for a paid API, a bug for abuse control |
| **Sliding log** | **Exact, and memory is bounded by the limit itself** |

**Atomicity via Lua.** The whole read-modify-write runs as one Lua script.
Separate `ZCARD` and `ZADD` calls leave a race where concurrent requests all see
the same under-limit count and all get admitted — exactly the burst the limiter
exists to stop. A test fires **40 concurrent requests at a limit of 5** and
asserts exactly 5 get through.

**Two separate budgets:** creation 20/min (writes a row, mints a permanent
public id) and redirects 600/min (blunts scanners without rationing real
traffic). Separate key namespaces, so a burst of creates cannot exhaust the
budget redirects depend on — there is a test for that.

**Fails open.** If Redis is unreachable the request is admitted. The trade is
explicit: during an outage there is no rate limiting at all. Failing closed would
convert a cache outage into a total outage.

**Weakness to admit:** limits are per-IP. Useless against a botnet (fresh budget
per address) and unfair to shared NAT (one budget for many users). The real
answer is per-account limits once accounts exist.

---

### Phase 3 — Click events over Redis pub/sub

**The redirect never waits on analytics.** `publishClick` returns `void`, not a
promise — a promise invites a caller to `await` it, and the moment a redirect
awaits analytics, an analytics problem becomes a user-facing latency problem.

**A separate consumer process,** because the two halves have opposite
requirements: the API is latency-critical and scales with request volume, the
consumer is throughput-oriented and scales with event volume. Sharing a process
lets a slow batch insert compete with a redirect for the same event loop.

**Batching on size OR time** (100 events / 500 ms), because either alone is
wrong: size-only strands the last events when traffic goes quiet, time-only
gives up throughput under load. Flushes are serialised so two cannot interleave.
A failed batch is logged and dropped rather than retried in place — retrying
would grow the buffer without bound during an outage.

**Privacy:** IP addresses are stored as a **salted** SHA-256, truncated to 32
characters. The salt matters — an *unsalted* hash of an IPv4 address is trivially
reversible, because the whole space is only 2^32 and fits in a rainbow table.

**This phase loses data on purpose.** Redis pub/sub is **at-most-once** with no
storage: publish into a room with nobody in it and the message is gone.
**Demonstrated, not assumed:** with the consumer stopped, four redirects were
served successfully and all four clicks were lost permanently.

---

### Phase 4 — Kafka replaces pub/sub

Same publisher contract, different guarantees. `EVENT_TRANSPORT` selects `redis`
or `kafka`, which makes them directly comparable.

**The experiment, run against both:**

| Transport | Consumer down during clicks | After consumer starts |
| --- | --- | --- |
| Redis pub/sub | redirects served | **all clicks lost permanently** |
| Kafka | redirects served | **all 6 replayed and recorded** |

Pub/sub is fan-out with no storage. Kafka is an **append-only log** — the broker
keeps the event and each consumer group tracks its own offset into it.

**Write first, acknowledge second.** The consumer uses `eachBatch` with
auto-resolve off: it writes the batch to Postgres, *then* resolves offsets and
commits. That ordering makes delivery **at-least-once** — a crash between the
write and the commit replays the batch, so events can be duplicated but never
lost. Committing first inverts the guarantee.

> **Honest consequence:** click counts can **over-count** after a consumer crash.
> Fixing it needs a deduplication key (an event id from the publisher plus a
> unique index). For a view counter that trade is usually not worth paying; for
> anything that bills or audits, it is.

**Partitioning by code.** Messages are keyed by short code, so every event for
one link lands on the same partition. That gives per-link ordering and lets a
consumer aggregate a link's clicks without coordinating across partitions.
Tested: 12 events with one key land on exactly one partition; 40 distinct keys
spread across several.

**Partition count is effectively permanent.** Auto-creation is disabled and the
count set explicitly (3), because an auto-created topic silently takes the broker
default of one partition. It cannot be lowered later, and raising it rehashes
keys to different partitions and breaks ordering for existing ones. It also caps
consumer parallelism: **one partition is read by at most one member of a group**,
so 3 partitions means at most 3 useful consumer instances.

**Rebalances handled explicitly:** if `isRunning()` or `isStale()` goes false
mid-batch the handler returns without committing, because committing would
acknowledge work another group member is about to redo.

---

### Phase 5 — Live trending leaderboard

**One sorted set per minute, not one running total.** The obvious implementation
is a single sorted set with `ZINCRBY` per click. It is also wrong: that set never
forgets, so a link that went viral last week outranks everything current forever.

Instead there is one sorted set per minute, each with a TTL slightly longer than
the window. "Trending" is a `ZUNIONSTORE` across the buckets still alive. Old
minutes leave the window because **Redis has already deleted them** — no sweep
job, no cleanup, no unbounded key growth. Sorted sets make both halves cheap:
`O(log N)` to increment, `O(log N + K)` to read the top K.

**Bucketed by `occurredAt`, not processing time.** Otherwise a consumer
restarting and replaying an hour of Kafka backlog would pour all of it into the
current minute and invent a spike that never happened. Phase 4 made backlog
replay a normal event, so this matters.

**Computed once per tick, not once per client.** The union is the expensive part.
It runs on a timer and fans out to every socket from memory, so cost depends on
the refresh interval rather than the number of viewers. That is the actual
argument for pushing over polling: with N clients polling, Redis does N unions
per interval; here it does one.

**Slow clients are dropped, not buffered.** If a client stops draining its
socket, the outbound buffer grows inside our process until memory runs out. Past
1 MB the socket is terminated — a leaderboard is worthless when stale.

**WebSocket vs SSE:** server-sent events would serve this equally well since the
traffic is one-directional. WebSockets leave room for the next feature
(subscribing to one link's live count), which needs a client-to-server channel.

---

### Phase 6 — Read replica and read/write split

A streaming standby built by cloning the primary on first start
(`pg_basebackup -R`). Writes go to the primary; reads that tolerate staleness go
to the replica.

**The interesting problem is read-your-writes.** Replication is asynchronous.
Create a link and click it immediately and the redirect can reach the replica
*before the row does* — a 404 for a link that demonstrably exists.

The usual answers are a synchronous replica (every write waits for the standby)
or routing recent reads to the primary (needs session tracking, gives back the
load you were shedding). **Neither is needed here, because Phase 1 already built
the fix:** creation seeds the cache with the row it just wrote, so a redirect for
a brand-new link is served from Redis and never consults the database. The lag
window is covered by a cache entry that cannot be stale, because the same request
that created the row wrote it.

**The replica is optional at every level.** Unset `DATABASE_REPLICA_URL` means
reads use the primary, with no separate code path. A failed replica read falls
back to the primary. `/ready` reports replication lag but never fails on it —
failing readiness for a replica outage would remove capacity for a condition the
service already handles.

**A measurement bug worth knowing:** `pg_last_xact_replay_timestamp()` returns
the time of the last *replayed transaction*, so on an idle system it ages forward
and a fully caught-up replica appears minutes behind. The fix is to report 0 when
`pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()`.

---

### Phase 7 — Partitioning the click-events table

`click_events` is the only table that grows without bound — one row per redirect,
forever. It is RANGE-partitioned by `occurredAt`, one partition per month.

| | Before | After |
| --- | --- | --- |
| Deleting old data | `DELETE` writes as much WAL as the rows it removes and leaves bloat for VACUUM | `DROP TABLE` on one partition: instant, disk returned immediately |
| "Last 7 days" query | Index scan over all history | Only partitions in range are touched (**partition pruning**) |
| VACUUM / ANALYZE / REINDEX | One enormous relation | Per partition |

Retention is the big win. On a billion-row table, `DELETE FROM click_events
WHERE occurredAt < ...` is an outage waiting to happen. Dropping a partition is
a catalogue update.

**The constraint that shapes the design:** Postgres requires the partition key
to appear in **every unique constraint**, so the primary key had to become
`(id, occurredAt)` rather than `id`. That is not a detail — it propagates into
every foreign key that would ever point at this table.

**The DEFAULT partition and its trap.** A `DEFAULT` partition catches rows
outside every declared range, so an insert can never fail. But while the default
holds rows for a month, creating *that month's* partition requires scanning it
and **fails** if any row conflicts. So the default is a safety net, not a working
part — a maintenance job provisions three months ahead to keep it empty, and
prunes past the retention horizon. It **detaches before dropping**, so a
long-running query cannot drag an ACCESS EXCLUSIVE lock onto the parent.

Pruning is asserted with `EXPLAIN` in the tests rather than assumed.

---

### Phase 8 — Containerising the application

**Multi-stage build.** Build stage has the full dependency tree, TypeScript
compiler and Prisma generation. Runtime stage has production dependencies and the
compiled output only — **537 MB vs 895 MB**.

**Two Prisma gotchas worth knowing:**

1. `npm ci --omit=dev` would run the `postinstall` hook, which calls
   `prisma generate`, which needs the Prisma CLI — a devDependency deliberately
   absent from the runtime image. So the runtime install uses `--ignore-scripts`
   and the generated client is **copied from the build stage**.
2. The container is Alpine (**musl libc**) and the host is not. Prisma ships a
   per-platform query engine, so without
   `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` the image builds
   cleanly, starts cleanly, and **fails on its first query**.

**Migrations are their own service.** `migrate` runs `prisma migrate deploy` once
and exits; `api` and `consumer` both wait on it with
`condition: service_completed_successfully`, so nothing serves traffic against an
unmigrated schema.

**Other details:** runs as the unprivileged `node` user (root inside a container
is one escape from root on the host); `package*.json` copied before `src/` so a
source edit does not invalidate the dependency layer; healthcheck hits `/health`
not `/ready`; the consumer has no port and no healthcheck because it serves
nothing.

---

### Phases 9 & 10 — Kubernetes and autoscaling

> ⚠️ **These manifests have never run on a cluster.** No cluster tool was
> available (no minikube, no kind, no context). They pass
> `kubeconform -strict` against Kubernetes 1.30 and `kustomize build` renders
> cleanly — that catches wrong API versions and misspelled fields. It proves
> nothing about scheduling, probes, or scaling. **Say this before you are asked.**

Resources: Deployments (api, consumer), Service, Ingress, PodDisruptionBudget,
migration Job, partition CronJob, HorizontalPodAutoscaler — wired with kustomize.

**Probes.** Liveness `/health` (never touches Postgres — see Phase 0), readiness
`/ready`, plus a **startupProbe** because otherwise a cold start longer than the
liveness threshold becomes an infinite restart loop.

**Shutdown is a race.** Removing a pod from the endpoints list and sending
SIGTERM happen concurrently, and proxies learn about removal asynchronously.
Without a `preStop` sleep of 5 s a pod can stop accepting connections before
every proxy knows it is going — **that is what deploy-time 502s usually are.**
`terminationGracePeriodSeconds: 30` against the app's own 10 s drain.

**The consumer deliberately has no HPA.** A Kafka partition is consumed by at
most one group member, so with 3 partitions a 4th replica does nothing but join
the group, sit idle, and force a rebalance whenever it starts or stops. Its
ceiling is a property of the topic, not of load.

**HPA choices:**
- CPU target **70% of the request** — utilisation is a percentage of the
  *request*, so an unset request means no CPU autoscaling at all
- **No CPU limit** — a CPU limit throttles a Node event loop in ways that look
  exactly like a slow dependency; the request already guarantees a floor
- `maxReplicas: 12` — the app is stateless and would scale further, but each
  replica opens Postgres and Redis connections, so the real ceiling is the
  **database connection limit**. Past that the answer is PgBouncer, not more pods
- **Scale up instantly, scale down over 5 minutes** — an overloaded redirect
  service is a down service; flapping costs more in cold caches and connection
  churn than idle pods save

A PodDisruptionBudget keeps 2 of 3 replicas during node drains and upgrades,
which are otherwise free to evict everything at once.

---

### Phase 11 — Load testing to the breaking point

Tool: **k6**, using an **arrival-rate executor rather than fixed VUs**. With VUs,
a slowing system quietly issues fewer requests and hides its own breaking point;
arrival rate holds offered load constant and lets the queue grow, which is what
actually happens in production.

**Results, `p95 < 200 ms` as the SLO:**

| Rate | 1 replica | 3 replicas |
| ---: | ---: | ---: |
| 200/s | **12 ms** | — |
| 400/s | 121 ms | **15 ms** |
| 600/s | 451 ms | **29 ms** |
| 800/s | 646 ms | — |
| 1000/s | — | **144 ms** |
| 1600/s | — | 438 ms |

**One replica holds ~400 req/s. Three hold ~1100.** Close to linear — the result
that justifies horizontal autoscaling.

**Errors stayed at 0.00% throughout.** The service does not fall over under
overload, it **queues**. Latency degrades long before anything fails, and `p99`
blows out to tens of seconds while `p95` still looks survivable. That gap is the
interesting part: an SLO written on averages, or even on p95, would have called
800 req/s healthy.

**What actually saturates** — `docker stats` at 1200 req/s, three replicas:

```
url-shortener-api-1   101.92%     <- pinned at one core
url-shortener-api-2   105.06%
url-shortener-api-3   101.81%
shortener-redis        45.48%
shortener-postgres     ~20%
```

**The bottleneck is Node being single-threaded** — one process uses one core no
matter how many the host has. That is why the fix is more replicas rather than a
bigger machine, and it is worth knowing *before* someone proposes vertical
scaling. It also proves the caching work: at 400 req/s per replica, Postgres is
nearly idle because almost every redirect is served from Redis.

**Methodological caveat:** the load generator ran on the same machine as the
system under test and k6 itself used ~78% of a core. The *shape* (linear scaling,
CPU-bound, zero errors) is trustworthy; the absolute figures are a lower bound.

---

### Phase 12 — Prometheus, Grafana, alerts

**The most important line in the metrics code** is the route label: it is the
**route pattern** (`/:code`), never the request path. Labelling with the path
would mint a new time series per short link — a million links would be a million
series, which is how people take down their own Prometheus. This is called
**cardinality explosion**. A test asserts the code never appears as a label
value; the live label set is exactly `["/:code", "/health", "/links"]`.

**Metrics chosen from what the load test found,** not from library defaults:

| Metric | Why |
| --- | --- |
| `nodejs_eventloop_lag_seconds` | The direct symptom of a CPU-bound Node process. **Rises before latency does** |
| `http_request_duration_seconds` | Histogram bucketed around the 200 ms SLO, so it has resolution where decisions are made |
| `redirect_cache_outcomes_total` | hit / miss / coalesced. A falling hit rate means Postgres is taking read traffic the cache exists to absorb |
| `rate_limit_rejections_total` | Distinguishes "we are being attacked" from "we are broken" |
| `click_events_dropped_total` | Analytics loss, invisible from the redirect path by design |

**Five alert rules, and the primary one is latency rather than errors** — because
Phase 11 measured that this service *queues* rather than failing. Error rate
stayed at 0.00% while p99 blew out to tens of seconds. An alert on errors alone
would have stayed silent through the entire overload.

Prometheus uses **DNS service discovery**, so `--scale api=3` is picked up
automatically; a static target would scrape one replica and silently miss the
rest. Grafana provisions its datasource and an 8-panel dashboard from files on
startup.

---

### Phase 13 — CI/CD

Five GitHub Actions jobs, ordered by how fast a failure can be known:

| Job | What it does |
| --- | --- |
| `static` | Typecheck + unit tests. No containers, ~1 minute |
| `integration` | Brings up Postgres + replica + Redis + Kafka via the same Compose file used locally, migrates, runs integration tests |
| `image` | Builds the runtime image with a GHA layer cache |
| `manifests` | Renders kustomize, validates with `kubeconform -strict` |
| `publish` | Builds and pushes to GHCR — **gated on an opt-in variable** |

**Reusing the Compose file rather than GitHub's `services:` block.** Kafka needs
two listeners with different advertised addresses and the replica needs a
`pg_basebackup` init step — neither fits that block. More importantly, expressing
the topology twice lets CI and local development drift apart, and the first
symptom is a test that passes locally and fails in CI for reasons nobody can
reproduce.

Also: `concurrency` with `cancel-in-progress`, `timeout-minutes` on every job
(the default is six hours), container logs dumped on failure, and Dependabot
grouping minor/patch updates into one PR while leaving majors individual.

---

## 5. The demo console

A single self-contained HTML file served at `GET /`. It creates links, lists
recent ones with click counts, and subscribes to `/live` for the trending board —
so **a click in one browser tab visibly moves the ranking in another**. That one
gesture shows the whole pipeline: redirect → Kafka → consumer → Postgres → Redis
sorted set → WebSocket → browser.

The link-listing endpoint sits behind the same API key as creation, because
listing every short link on a public deployment would hand a scanner the entire
table without it needing to guess a single code.

---

## 6. Two deployment shapes

`APP_PROFILE` selects which dependencies get wired in at startup. **One codebase**
— the difference is wiring, not which code exists.

| | `full` | `minimal` |
| --- | --- | --- |
| Where | Docker Compose / containers | Vercel / serverless |
| Storage | Postgres + replica | Postgres (Supabase) |
| Cache, rate limiting, trending | Redis | none |
| Click analytics | Kafka + consumer | none |
| Live leaderboard | WebSocket | none |

**Why the split is not laziness:** a serverless function wakes up, answers one
request, and is frozen or discarded. There is nowhere to keep a Redis connection
pooled, a WebSocket open, a 2-second timer ticking, or a Kafka consumer running.
Those need a process that stays alive between requests.

In minimal mode a **null cache** reports a miss every time and reads fall through
to Postgres — the same behaviour the real cache degrades to when Redis is
unreachable, which is why no other code needs to know which one it has. Trending
is **omitted rather than stubbed** (an always-empty board looks broken), and rate
limiting is omitted rather than faked (a per-instance limiter on serverless counts
each cold start separately and only *looks* like protection).

**Supabase specifics:** the app uses the **pooled** connection (pgbouncer, port
6543) because serverless opens a connection per instance; migrations use the
**direct** connection (port 5432) because DDL and advisory locks do not survive a
transaction-mode pooler. Hence Prisma's `url` + `directUrl`.

---

## 7. Testing

**136 tests, `node:test`, zero test-framework dependencies.**

- **Unit (46)** — no infrastructure, runs in ~1 second. Base62 codec, code
  permutation and its inverse, cache-aside resolver against fakes (exact "how
  many times did we touch the database" assertions), the batcher, event parsing,
  Vercel path recovery.
- **Integration (90)** — real Postgres, real Redis, real Kafka, real HTTP server
  on an ephemeral port. Cleans up the rows it creates.

Tests worth quoting in a viva:
- 20 concurrent requests for a cold key produce **exactly 1** database read
- 40 concurrent requests at a limit of 5 admit **exactly 5**
- 12 Kafka messages with one key land on **exactly 1** partition
- A partitioned query's `EXPLAIN` names September and **does not** name July
- The short code **never** appears as a Prometheus label value
- The replica **refuses** writes (`cannot execute INSERT in a read-only transaction`)

`createApp` takes its dependencies as arguments rather than importing singletons.
That is what lets the suite start the app on an ephemeral port without the module
also deciding to bind port 3000 as a side effect.

---

## 8. Commands

```bash
# Demo
docker compose --profile app up -d     # whole system, 8 containers
npm run demo:reset                     # wipe and seed 6 links with clicks
npm run traffic                        # steady clicks so Grafana moves
# http://localhost:3000  console
# http://localhost:3001  Grafana
# http://localhost:9090  Prometheus

# Development
docker compose up -d                   # infrastructure only
npm run dev                            # API with watch
npm run dev:consumer                   # analytics consumer

# Quality
npm test                               # 136 tests
npm run typecheck
npm run k8s:validate                   # kubeconform, offline

# Load testing
docker compose -f docker-compose.yml -f docker-compose.loadtest.yml --profile app up -d
npm run loadtest
```

---

## 9. Known limitations — state these before you are asked

- **The Kubernetes manifests have never run on a cluster.** Schema-valid, not
  cluster-tested.
- **Never deployed publicly.** Runs locally only.
- **No authentication or accounts.** Links are anonymous and permanent; no way to
  list, edit, revoke or expire one. `CREATE_API_KEY` is a single shared secret,
  not a user system.
- **Rate limits are per-IP** — defeated by a botnet, unfair to shared NAT.
- **Click counts can over-count** after a consumer crash: delivery is
  at-least-once with no dedup key.
- **Single-flight is per-process** — N instances still cost N reads for a cold key.
- **The code multiplier is not secret**, so enumeration is only made expensive,
  not prevented.
- **`npm audit` reports 3 high advisories** in `deepmerge-ts`, reached only via
  the `prisma` CLI devDependency. No patched version in range; not runtime code.
- **Load-test numbers are a lower bound** — the generator shared a machine with
  the system under test.

---

## 10. Likely viva questions, with answers

**Why not use a UUID for the short code?**
Too long (36 characters defeats the purpose), and random means you must check for
collisions on every insert. Deriving from the primary key gives uniqueness for
free; the permutation gives unpredictability without giving up that property.

**What happens if two people shorten the same URL?**
They get two different codes, deliberately. Deduplicating needs a lookup before
every insert and an index on a 2 KB column, and it merges the analytics of
unrelated campaigns.

**How would you scale to a billion links?**
The code space is 3.5 trillion, so codes are fine. The bottlenecks in order:
(1) Node is single-threaded — add replicas, which the load test proves is
near-linear; (2) database connections — add PgBouncer; (3) read volume — the
cache already absorbs most of it, then more replicas; (4) `click_events` size —
already partitioned, so retention is a `DROP TABLE`.

**Why 302 and not 301?**
301 is cached permanently by browsers and proxies, so clicks stop reaching us.
Analytics are the product. 302 plus `no-store` guarantees every click is counted,
and it also keeps links editable and revocable.

**What happens when Redis dies?**
Everything keeps working, slower. Cache lookups report a miss and read through to
Postgres, and the rate limiter fails open. Verified by killing the container
mid-traffic: redirects kept serving in ~13 ms. Readiness deliberately ignores
Redis, so instances are not pulled from the load balancer.

**What happens when Kafka dies?**
Redirects are unaffected — publishing is fire-and-forget and never awaited.
Click events are dropped and a counter records it. Once Kafka returns, new events
flow again; events published during the outage are lost, since the producer could
not reach the broker.

**Is your click count exactly right?**
No, and that is a deliberate choice. Delivery is at-least-once, so a consumer
crash between writing and committing replays a batch and can over-count. Exactness
needs a dedup key and a unique index. For a view counter the trade is not worth
it; for billing it would be.

**Why is the consumer a separate process?**
Opposite requirements. The API is latency-critical and scales with request volume;
the consumer is throughput-oriented and scales with event volume. In one process
a slow batch insert competes with a redirect for the same event loop.

**How do you handle a link that suddenly goes viral?**
Three layers. The cache serves it after the first request. Single-flight makes
concurrent cold misses share one database read. The HPA adds replicas on CPU. The
trending board is per-minute buckets, so it reflects the spike immediately rather
than being drowned by history.

**Why does the health check not check the database?**
Because liveness answers "should this process be killed and restarted". If it
checked the database, one blip would fail every pod at once and Kubernetes would
restart the whole fleet — turning a recoverable outage into a crash loop.
Readiness is the check that *should* look at the database, and it does.
