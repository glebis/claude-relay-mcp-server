```
  _____ _                 _        ____       _
 / ____| |               | |      |  _ \     | |
| |    | | __ _ _   _  __| | ___  | |_) |___ | | __ _ _   _
| |    | |/ _` | | | |/ _` |/ _ \ |  _ </ _ \| |/ _` | | | |
| |____| | (_| | |_| | (_| |  __/ | |_) |  __/| | (_| | |_| |
 \_____|_|\__,_|\__,_|\__,_|\___| |____/ \___||_|\__,_|\__, |
                                                         __/ |
                                                        |___/
```

# Claude Relay MCP Server

An MCP server for inter-session communication between [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances. Route tasks, group chat, and coordinate multiple AI agents across machines with persistent storage, access control, and @mention routing.

## How it works

```
Session A (host)          Relay Server           Session B (client)
    |                          |                        |
    |-- relay_send_task ------>|                        |
    |                          |-- SSE push task ------>|
    |                          |                   (processes task)
    |                          |<-- relay_reply --------|
    |<-- channel notification -| (task completed)       |
```

The relay runs as an MCP server over stdio. In **host mode**, it also starts an HTTP server that accepts tasks and broadcasts them via SSE. In **client mode** (port already taken), it subscribes to the host's SSE stream and relays messages to the local Claude Code session.

## Features

- **SQLite persistence** (WAL mode) -- tasks, chat, and machine registry survive restarts
- **Optimistic locking** -- version-based concurrency control prevents race conditions
- **Idempotency keys** -- safe task retry without duplication
- **Rooms with ACL** -- per-agent read/write/history permissions per room
- **@mention routing** -- `@researcher` delivers only to that agent
- **Circuit breaker** -- degraded machines stop receiving tasks after 3 consecutive failures
- **Exponential backoff** -- SSE reconnection with jitter prevents thundering herd
- **Self-dedup** -- agents never receive their own broadcast messages
- **Audit log** -- every state transition recorded for debugging
- **Observer stream** -- SSE firehose at `/observe` for dashboards

## Quick Start

```bash
npm install
npm run build
```

### Host session (runs the HTTP server)

```bash
claude --dangerously-load-development-channels server:claude-relay
```

### Client session (connects to host via SSE)

```bash
RELAY_URL=http://host-ip:8788 RELAY_SESSION_NAME=worker \
  claude --dangerously-load-development-channels server:claude-relay
```

### Cross-machine (via Tailscale or direct IP)

```bash
# On remote machine
RELAY_URL=http://100.86.56.43:8788 \
RELAY_TOKEN=your-shared-secret \
RELAY_SESSION_NAME=mac-mini \
  claude --dangerously-load-development-channels server:claude-relay
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `8788` | HTTP server port |
| `RELAY_BIND` | `0.0.0.0` | Bind address |
| `RELAY_URL` | `http://127.0.0.1:8788` | Relay URL (client mode) |
| `RELAY_TOKEN` | _(empty)_ | Bearer token for auth (empty = open) |
| `RELAY_SESSION_NAME` | _(auto)_ | Session identifier |
| `RELAY_TASK_TTL_HOURS` | `8` | Task expiry time |
| `RELAY_DB_PATH` | `relay.db` | SQLite database file path |

## MCP Tools

| Tool | Description |
|------|-------------|
| `relay_send_task` | Send a task to another session. Returns task ID for polling. |
| `relay_check_task` | Check task status and retrieve result. |
| `relay_reply` | Report task result back to the requester. |
| `relay_list_machines` | List connected machines with online/offline status. |
| `relay_chat` | Send a group chat message to a room. |
| `relay_chat_history` | Get recent chat history for a room. |
| `relay_respond_permission` | Approve/deny a remote session's tool permission request. |

## HTTP API

### Tasks

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/task` | Yes | Create task (supports `idempotency_key`) |
| GET | `/task/:id` | Yes | Check task status and result |
| PUT | `/task/:id` | Yes | Submit task result |
| GET | `/tasks` | Yes | List all tasks |

### Chat

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/chat` | Yes | Send chat message (supports `@mentions`) |
| GET | `/chat` | Yes | Get chat history by room |

### Rooms & Access Control

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/rooms` | Yes | List all rooms with ACL |
| POST | `/rooms` | Yes | Create room with permissions |
| PUT | `/rooms/:id/acl` | Yes | Set per-agent permissions |

Room permissions per agent: `read`, `write`, `history` (each true/false). Default is open (all allowed).

### Machines

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/machines` | Yes | List machines with online/degraded/offline status |
| POST | `/machines/heartbeat` | Yes | Client heartbeat |

### Permissions

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/permission` | Yes | Permission verdict (allow/deny) |
| GET | `/permissions` | Yes | List pending permission requests |

### Streams & Observability

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | No | Health check |
| GET | `/subscribe` | Yes | SSE stream for client sessions |
| GET | `/observe` | Yes | SSE firehose of all events (for dashboards) |
| GET | `/history` | Yes | Full event history for initial load |

## Architecture

```
src/
├── index.ts              # Entry point — wires modules, HTTP routes, MCP tools
├── relay/
│   ├── tasks.ts          # Task store: CRUD, state machine, optimistic locking
│   ├── chat.ts           # Chat store: rooms, history
│   ├── machines.ts       # Machine registry: heartbeat, circuit breaker
│   └── permissions.ts    # Permission request/grant flow (in-memory)
└── store/
    ├── db.ts             # SQLite setup, WAL mode, migrations
    ├── schema.ts         # Table definitions
    └── audit.ts          # Append-only audit log
```

- **Modular monolith** -- domain modules with clear boundaries, single process
- **Dual-mode** -- host (HTTP server) or client (SSE subscriber), auto-detected at startup
- **SQLite WAL** -- persistent storage with ~50,000 writes/sec headroom
- **Optimistic locking** -- `version` column on tasks prevents concurrent update conflicts
- **Circuit breaker** -- 3 consecutive failures marks a machine as `degraded`
- **Exponential backoff + jitter** -- SSE reconnection: `min(30s, 1s * 2^attempt * random)`

## Development

```bash
npm run dev    # Watch mode with tsx
npm run build  # Compile TypeScript
npm test       # Run tests (48 tests across 7 suites)
```

## Roadmap

- **Human-in-the-loop review UI** -- three-panel dashboard for evaluating agent output
- **LLM-as-judge** -- automatic rubric scoring with human override
- **Failure taxonomy** -- structured tagging for discovering where agents break
- **Obsidian export** -- evaluation data exported to vault for reflection
- **Ack protocol** -- delivery confirmation with retry and dead letter queue

See [PLAN.md](PLAN.md) for the full v2 design.

## Related Projects

- [Claude Skills](https://github.com/glebis/claude-skills) — 35+ skills for Claude Code
- [Claude Code Lab](https://claude-code.glebkalinin.com/) — Hands-on workshops for AI-augmented development

## Author

[Gleb Kalinin](https://www.linkedin.com/in/glebkalinin/) — educator, product designer, builder of human-AI collaboration tools.

## License

Apache 2.0 — see [LICENSE](LICENSE).
