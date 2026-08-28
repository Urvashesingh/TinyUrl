# URL Shortener with Real-Time Analytics

A URL shortener built phase by phase, each phase introducing one piece of
distributed-systems machinery and the reasoning behind it. **Phase 0 — the core
API — is complete and tested.**

- Node 22 · TypeScript (strict) · Express
- PostgreSQL via Prisma
- Docker Compose for local infrastructure
- 31 tests on `node:test`, no test framework dependency

## Quick start

```bash
docker compose up -d          # Postgres
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

`npm test` expects the Compose Postgres to be up; the integration suite drives a
real HTTP server against a real database and cleans up the rows it creates.

## API

| Method | Path      | Behaviour |
| ------ | --------- | --------- |
| `GET`  | `/health` | Liveness. Always `200` while the process is up; never touches Postgres. |
| `GET`  | `/ready`  | Readiness. `200` when Postgres answers, `503` when it does not. |
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
src/base62.ts   base62 codec over bigint
src/codes.ts    id <-> code, the permutation that makes codes unguessable
src/app.ts      createApp(prisma) -> Express app, no side effects
src/index.ts    listen, signal handling, graceful shutdown
test/           unit tests for the codec, integration tests for the API
```

`createApp` takes the Prisma client as an argument rather than importing a
singleton. That is what lets the integration suite start the app on an ephemeral
port without the module also deciding to bind port 3000 as a side effect.

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

## Known limitations

Deliberately unaddressed at this phase, and the honest answers if asked:

- **No rate limiting.** Anyone can create links in a loop. That is Phase 2.
- **No auth.** Links are anonymous and permanent; there is no way to list, edit,
  revoke, or expire one.
- **Every redirect hits Postgres.** Fine at this scale, and precisely the
  problem Phase 1's cache-aside layer exists to solve.
- **`console.log`, not structured logs.** No request ids, no correlation. Phase 1.
- **Single instance.** No connection-pool tuning, no read replica, no metrics.
- **The multiplier is not secret**, as discussed above.

## Phase tracker

- [x] **Phase 0** — Core API: create short link + redirect
- [ ] **Phase 1** — Redis cache (cache-aside) + structured logging
- [ ] **Phase 2** — Rate limiter (Redis)
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
