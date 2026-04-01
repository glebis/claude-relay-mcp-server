# Claude Relay MCP Server — v2 Plan

## Vision
A reliable, human-in-the-loop MCP relay for inter-agent communication with structured evaluation interfaces.

## Current State (v1)
- Single 1318-line TypeScript file
- HTTP + SSE transport, in-memory stores
- 7 MCP tools: send_task, check_task, reply, list_machines, chat, chat_history, respond_permission
- 14 HTTP endpoints
- Primitive HITL: permission request/grant flow
- No delivery guarantees, no persistence, no review UI

## Known Bugs
- `broadcastSSE()` doesn't filter sender — agents receive own broadcast tasks
- Fixed SSE reconnect delays (2s/5s), no jitter — thundering herd risk

---

## Phase 1: Fix & Ship Public (Day 1)

### 1.1 Dedup fix
- Add sender filter to `broadcastSSE()`: `if (sender && sub.senderId === sender) continue;`

### 1.2 Exponential backoff + jitter
- Replace fixed 2s/5s in `subscribeToSSE()` with:
  ```ts
  const delay = Math.min(30000, 1000 * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5));
  ```

### 1.3 Public repo setup
- .gitignore (node_modules, dist, .enzyme, .env, *.db)
- LICENSE (TBD — not MIT)
- README.md with architecture, quickstart, config, tools reference
- .env.example documenting all env vars
- Links to Gleb's projects + LinkedIn

---

## Phase 2: Durability (Week 1)

### 2.1 SQLite WAL storage (better-sqlite3)
- Replace `Map<string, Task>` with `tasks` table
- Replace `ChatMessage[]` with `chat_messages` table
- Add `dead_letters` table
- Add `audit_log` table (append-only)
- ~80 lines, ~50,000 writes/sec headroom

### 2.2 better-sse
- Replace manual `res.write("data: ...")` with better-sse
- Enables `Last-Event-ID` — zero message loss on reconnect
- Handles backpressure, heartbeats, client disconnect detection

### 2.3 p-retry + p-timeout
- Wrap SSE reconnection with exponential backoff
- Add timeout to stalled connections

---

## Phase 3: Human-in-the-Loop (Week 2)

### 3.1 Review state machine
Expand task states:
```
created → pending → delivered → acked → in_progress → awaiting_review → approved/rejected → done/revision/dead
```
- Add `revision_count`, `feedback_history[]` to Task
- Cap revisions at 3

### 3.2 Confidence-based routing
- Add optional `confidence` (0-1) field to `relay_reply`
- Configurable threshold (default 0.85)
- Below threshold → `awaiting_review` instead of `done`
- Above → auto-complete
- ~60 lines

### 3.3 Review endpoints
- `GET /review-queue` — tasks awaiting human review
- `POST /task/:id/review` — submit verdict: `{action: "approve"|"reject"|"edit", feedback?, rating?, editedContent?}`
- `GET /task/:id/history` — full state transition audit trail

### 3.4 Structured feedback schema
```json
{
  "item_id": "abc123",
  "verdict": "approve|reject|comment",
  "ratings": { "accuracy": 4, "completeness": 3 },
  "comment": "Free text",
  "timestamp": "2026-04-01T14:00:00Z"
}
```
- Rubric dimensions configurable per task type
- Store in `feedback` SQLite table

### 3.5 Audit trail
- Append-only log: `{timestamp, actor, action, taskId, payload_hash}`
- Every state transition logged
- `GET /audit/:taskId` endpoint
- ~80 lines

### 3.6 Feedback-to-improvement loop
- New `feedback` store in SQLite
- New MCP tool: `relay_get_feedback(topic?)` — agents retrieve past feedback for similar tasks
- Agents self-improve by checking feedback before responding
- ~120 lines

---

## Phase 4: Review Dashboard UI (Week 2-3)

### 4.1 Single HTML file served from relay
- `GET /review` serves static HTML (~300 lines)
- Vanilla JS + SSE EventSource API
- No build step, no framework, no npm

### 4.2 Dashboard features
- Real-time agent activity sidebar (tasks, chat, machines)
- Review queue: cards with task input (left) + agent output (right)
- Three-action model (GitHub PR style): Approve / Request Changes / Comment
- Rating rubric: 1-5 scale per dimension (radio buttons / tappable numbers)
- Free text feedback field
- Collapsible sections via `<details>`

### 4.3 Mobile-friendly
- Responsive CSS Grid, cards stack vertically on small screens
- Touch targets ≥ 44x44px
- Works in mobile Safari/Chrome
- SSE works on all modern mobile browsers

---

## Phase 5: Access Control (Week 3-4)

### 5.1 Per-room ACL
- Room config: `{ agents: { "researcher": { read: true, write: false, history: true }, "mac-mini": { read: true, write: true, history: true } } }`
- Enforced on chat POST, chat GET, SSE subscription

### 5.2 @mention routing
- Parse `@agent-name` in messages
- `@researcher` delivers only to researcher session
- `@all` for explicit broadcast

### 5.3 History access control
- Some agents: full history access
- Some agents: live-only (no GET /chat history)

### 5.4 Sync/async review modes
- `review_mode: "sync"` — agent blocks, waits for human
- `review_mode: "async"` — agent queues output, continues to next task
- Default sync for destructive actions, async for content/research

---

## Phase 6: Reliability Hardening (Week 4+)

### 6.1 Ack protocol
- `POST /task/:id/ack` — receiver confirms receipt
- Re-broadcast if no ack in 10s with backoff
- After 5 attempts → dead letter

### 6.2 Idempotency keys
- Optional `idempotencyKey` on task creation
- Dedupes retried POSTs

### 6.3 Task-level retry policies
```ts
{ maxAttempts: 3, initialInterval: 1000, backoffCoefficient: 2, maxInterval: 30000, nonRetryableErrors: ["INVALID_INPUT", "AUTH_FAILED"] }
```

### 6.4 Circuit breaker per machine
- Track consecutive failures per receiver
- 3 failures → `degraded` status, 60s cooldown
- Stop routing to degraded machines

### 6.5 Activity heartbeats
- Long tasks: `POST /task/:id/heartbeat`
- Configurable timeout per task (default 30s)
- No heartbeat → task timed out, eligible for retry

### 6.6 Unix domain socket transport
- `/tmp/claude-relay.sock` for local sessions
- ~2-3x faster than TCP loopback
- Node `net.createServer` natively

---

## Dependencies

### Add in Phase 1
- None (pure bugfix + repo setup)

### Add in Phase 2
- `better-sqlite3` — synchronous SQLite with WAL
- `better-sse` — correct SSE implementation
- `p-retry` — exponential backoff
- `p-timeout` — stall detection

### Consider later
- NATS (if multi-machine pub/sub needed beyond Tailscale)
- launchd plist (macOS process supervision)

---

## Architecture Target

```
Transport:  HTTP + SSE (remote)  |  Unix socket (local)  |  MCP stdio
Storage:    SQLite WAL (tasks, chat, dead letters, feedback, audit)
Reliability: ack + retry + idempotency + dead letter + circuit breaker
HITL:       confidence routing + review queue + structured feedback + revision loop
Access:     per-room ACL, @mentions, self-dedup
UI:         single-file HTML dashboard served from relay
```
