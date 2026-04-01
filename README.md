# Claude Relay MCP Server

An MCP server for inter-session communication between [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances. Route tasks, group chat, and coordinate multiple AI agents across machines.

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

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | No | Health check |
| POST | `/task` | Yes | Create task |
| GET | `/task/:id` | Yes | Check task status |
| PUT | `/task/:id` | Yes | Submit task result |
| GET | `/tasks` | Yes | List all tasks |
| GET | `/subscribe` | Yes | SSE stream for clients |
| POST | `/chat` | Yes | Send chat message |
| GET | `/chat` | Yes | Get chat history |
| GET | `/machines` | Yes | List machines |
| POST | `/machines/heartbeat` | Yes | Client heartbeat |
| POST | `/permission` | Yes | Permission verdict |
| GET | `/permissions` | Yes | List pending permissions |
| GET | `/observe` | Yes | SSE firehose (all events) |
| GET | `/history` | Yes | Full event history |

## Architecture

- **Dual-mode**: Host (HTTP server) or client (SSE subscriber), auto-detected at startup
- **Authentication**: Optional Bearer token via header or query param
- **Machine registry**: Heartbeat-based presence detection (30s interval, 90s timeout)
- **Task lifecycle**: Created → Pending → Done/Error, with TTL-based cleanup
- **Chat**: Room-based group messaging with history (200 message cap)
- **Observer stream**: SSE firehose at `/observe` for dashboards

## Development

```bash
npm run dev    # Watch mode with tsx
npm run build  # Compile TypeScript
npm test       # Run tests
```

## Related Projects

- [Claude Skills](https://github.com/glebis/claude-skills) — 35+ skills for Claude Code
- [Claude Code Lab](https://claude-code.glebkalinin.com/) — Hands-on workshops for AI-augmented development

## Author

[Gleb Kalinin](https://www.linkedin.com/in/glebkalinin/) — educator, product designer, builder of human-AI collaboration tools.

## License

Apache 2.0 — see [LICENSE](LICENSE).
