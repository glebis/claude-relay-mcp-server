# Rooms & Access Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit room registry with per-agent ACL (read/write/history), @mention routing, and self-dedup fix to the claude-relay MCP server.

**Architecture:** Extract room/ACL domain into `src/rooms.ts` as a pure in-memory module. Wire it into `src/index.ts` at the broadcast and HTTP handler level. Rooms auto-create with open permissions for backward compat; ACLs are opt-in.

**Tech Stack:** TypeScript, Node.js 18+, @modelcontextprotocol/sdk, zod, node:http, node:test (native test runner)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/rooms.ts` | **Create** | Room registry, Permission types, ACL enforcement, @mention parsing |
| `src/rooms.test.ts` | **Create** | Unit tests for rooms module (node:test) |
| `src/index.ts` | **Modify** | Import rooms, wire ACL checks into broadcast/HTTP/MCP, add new tools+endpoints, fix self-dedup |
| `src/index.test.ts` | **Create** | Integration tests for HTTP endpoints (node:test) |
| `package.json` | **Modify** | Add `test` script |

---

### Task 1: Test infrastructure setup

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add test script to package.json**

In `package.json`, add to the `"scripts"` section:

```json
"test": "node --import tsx --test src/**/*.test.ts"
```

- [ ] **Step 2: Verify test runner works**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: exits with 0, "no test files matched" or similar (no tests exist yet)

- [ ] **Step 3: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add package.json
git commit -m "chore: add test script using node:test + tsx"
```

---

### Task 2: Room domain module — types and RoomRegistry

**Files:**
- Create: `src/rooms.ts`
- Create: `src/rooms.test.ts`

- [ ] **Step 1: Write failing tests for Permission and Room types**

Create `src/rooms.test.ts`:

```typescript
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  RoomRegistry,
  OPEN_PERMISSION,
  READ_ONLY,
  extractMentions,
  type Permission,
  type RoomConfig,
} from "./rooms.js";

describe("RoomRegistry", () => {
  it("creates a room with default open permissions", () => {
    const registry = new RoomRegistry();
    const room = registry.create({ id: "general", name: "General" });
    assert.equal(room.id, "general");
    assert.equal(room.name, "General");
    assert.deepEqual(room.defaultPermission, OPEN_PERMISSION);
  });

  it("rejects duplicate room IDs", () => {
    const registry = new RoomRegistry();
    registry.create({ id: "ops", name: "Ops" });
    assert.throws(() => registry.create({ id: "ops", name: "Ops2" }), /already exists/);
  });

  it("rejects invalid room IDs", () => {
    const registry = new RoomRegistry();
    assert.throws(() => registry.create({ id: "UPPER", name: "Bad" }), /invalid/i);
    assert.throws(() => registry.create({ id: "", name: "Empty" }), /invalid/i);
    assert.throws(() => registry.create({ id: "has spaces", name: "Bad" }), /invalid/i);
  });

  it("lists all rooms", () => {
    const registry = new RoomRegistry();
    registry.create({ id: "a", name: "A" });
    registry.create({ id: "b", name: "B" });
    const list = registry.list();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((r) => r.id).sort(), ["a", "b"]);
  });

  it("ensureRoom creates room if missing, returns existing if present", () => {
    const registry = new RoomRegistry();
    const r1 = registry.ensureRoom("general");
    assert.equal(r1.id, "general");
    const r2 = registry.ensureRoom("general");
    assert.equal(r1, r2); // same object
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: FAIL — cannot import from `./rooms.js`

- [ ] **Step 3: Implement Room types and RoomRegistry**

Create `src/rooms.ts`:

```typescript
/**
 * Room registry with per-agent ACL for the claude-relay.
 * Pure in-memory module — no I/O dependencies.
 */

export interface Permission {
  read: boolean;
  write: boolean;
  history: boolean;
}

export interface RoomACLEntry {
  agentId: string;
  permission: Permission;
}

export interface RoomConfig {
  id: string;
  name: string;
  createdBy?: string;
  defaultPermission?: Permission;
  acl?: RoomACLEntry[];
}

export interface Room {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  defaultPermission: Permission;
  acl: Map<string, Permission>;
}

export const OPEN_PERMISSION: Permission = { read: true, write: true, history: true };
export const READ_ONLY: Permission = { read: true, write: false, history: false };
export const READ_HISTORY: Permission = { read: true, write: false, history: true };
export const WRITE_ONLY: Permission = { read: false, write: true, history: false };

const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class RoomRegistry {
  private rooms = new Map<string, Room>();

  create(config: RoomConfig): Room {
    const id = config.id;
    if (!ROOM_ID_RE.test(id)) {
      throw new Error(`Invalid room ID "${id}": must be lowercase alphanumeric/dashes, 1-63 chars`);
    }
    if (this.rooms.has(id)) {
      throw new Error(`Room "${id}" already exists`);
    }
    const room: Room = {
      id,
      name: config.name,
      createdAt: Date.now(),
      createdBy: config.createdBy || "system",
      defaultPermission: config.defaultPermission || OPEN_PERMISSION,
      acl: new Map(),
    };
    if (config.acl) {
      for (const entry of config.acl) {
        room.acl.set(entry.agentId, entry.permission);
      }
    }
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  list(): Room[] {
    return Array.from(this.rooms.values());
  }

  ensureRoom(id: string): Room {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    return this.create({ id, name: id });
  }

  setAgentPermission(roomId: string, agentId: string, permission: Permission): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room "${roomId}" not found`);
    room.acl.set(agentId, permission);
  }

  removeAgentPermission(roomId: string, agentId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room "${roomId}" not found`);
    room.acl.delete(agentId);
  }

  private resolve(roomId: string, agentId: string): Permission {
    const room = this.rooms.get(roomId);
    if (!room) return OPEN_PERMISSION; // unknown room = open (backward compat)
    return room.acl.get(agentId) || room.defaultPermission;
  }

  canRead(roomId: string, agentId: string): boolean {
    return this.resolve(roomId, agentId).read;
  }

  canWrite(roomId: string, agentId: string): boolean {
    return this.resolve(roomId, agentId).write;
  }

  canAccessHistory(roomId: string, agentId: string): boolean {
    return this.resolve(roomId, agentId).history;
  }

  /** Returns agent IDs from connectedAgents that have read permission on the room */
  getReadableAgents(roomId: string, connectedAgents: string[]): string[] {
    return connectedAgents.filter((a) => this.canRead(roomId, a));
  }

  /** Serialize a room for JSON responses */
  serialize(room: Room): Record<string, unknown> {
    return {
      id: room.id,
      name: room.name,
      createdAt: room.createdAt,
      createdBy: room.createdBy,
      defaultPermission: room.defaultPermission,
      acl: Array.from(room.acl.entries()).map(([agentId, permission]) => ({
        agentId,
        permission,
      })),
    };
  }
}

/**
 * Extract @mentions from a message. Returns agent names without the @ prefix, lowercased.
 * Handles: start of string, after whitespace, after punctuation (comma, colon, etc.)
 * Case-insensitive: @Researcher -> "researcher" to match senderId conventions.
 */
export function extractMentions(message: string): string[] {
  const matches = message.match(/(?:^|[\s,;:!?()])@([\w-]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/^[\s,;:!?()]+@/, "").toLowerCase()))];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/rooms.ts src/rooms.test.ts
git commit -m "feat: add Room domain module with RoomRegistry and Permission types"
```

---

### Task 3: ACL enforcement tests

**Files:**
- Modify: `src/rooms.test.ts`

- [ ] **Step 1: Add ACL tests**

Append to `src/rooms.test.ts`, inside the existing `describe("RoomRegistry")` block:

```typescript
  it("applies per-agent permissions over defaults", () => {
    const registry = new RoomRegistry();
    registry.create({
      id: "ops",
      name: "Ops",
      defaultPermission: OPEN_PERMISSION,
      acl: [{ agentId: "researcher", permission: READ_ONLY }],
    });
    // researcher has explicit READ_ONLY
    assert.equal(registry.canRead("ops", "researcher"), true);
    assert.equal(registry.canWrite("ops", "researcher"), false);
    assert.equal(registry.canAccessHistory("ops", "researcher"), false);
    // unknown agent gets default OPEN
    assert.equal(registry.canWrite("ops", "some-agent"), true);
  });

  it("setAgentPermission updates existing ACL", () => {
    const registry = new RoomRegistry();
    registry.create({ id: "ops", name: "Ops" });
    registry.setAgentPermission("ops", "bot", { read: true, write: false, history: true });
    assert.equal(registry.canWrite("ops", "bot"), false);
    assert.equal(registry.canAccessHistory("ops", "bot"), true);
  });

  it("unknown room returns open permission (backward compat)", () => {
    const registry = new RoomRegistry();
    assert.equal(registry.canRead("nonexistent", "anyone"), true);
    assert.equal(registry.canWrite("nonexistent", "anyone"), true);
  });

  it("getReadableAgents filters by read permission", () => {
    const registry = new RoomRegistry();
    registry.create({
      id: "secret",
      name: "Secret",
      defaultPermission: { read: false, write: false, history: false },
      acl: [
        { agentId: "alice", permission: { read: true, write: true, history: true } },
        { agentId: "bob", permission: { read: true, write: false, history: false } },
      ],
    });
    const readable = registry.getReadableAgents("secret", ["alice", "bob", "charlie"]);
    assert.deepEqual(readable.sort(), ["alice", "bob"]);
  });
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: All tests PASS (9 total)

- [ ] **Step 3: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/rooms.test.ts
git commit -m "test: add ACL enforcement tests for RoomRegistry"
```

---

### Task 4: @mention extraction tests and edge cases

**Files:**
- Modify: `src/rooms.test.ts`

- [ ] **Step 1: Add mention extraction tests**

Append to `src/rooms.test.ts`, after the RoomRegistry describe block:

```typescript
describe("extractMentions", () => {
  it("extracts single mention", () => {
    assert.deepEqual(extractMentions("hey @researcher check this"), ["researcher"]);
  });

  it("extracts multiple mentions", () => {
    const result = extractMentions("@alice and @bob please review");
    assert.deepEqual(result.sort(), ["alice", "bob"]);
  });

  it("deduplicates mentions", () => {
    assert.deepEqual(extractMentions("@alice @alice @alice"), ["alice"]);
  });

  it("handles dashes and underscores in names", () => {
    assert.deepEqual(extractMentions("@mac-mini and @session_01"), ["mac-mini", "session_01"]);
  });

  it("returns empty for no mentions", () => {
    assert.deepEqual(extractMentions("no mentions here"), []);
  });

  it("ignores email-like patterns", () => {
    // email has no space before @, so should not match
    assert.deepEqual(extractMentions("email user@example.com"), []);
  });

  it("handles mention at start of message", () => {
    assert.deepEqual(extractMentions("@researcher do this"), ["researcher"]);
  });

  it("lowercases mentions for case-insensitive matching", () => {
    assert.deepEqual(extractMentions("@Researcher check this"), ["researcher"]);
  });

  it("handles mentions after punctuation", () => {
    const result = extractMentions("hey,@alice and @bob: @charlie check");
    assert.deepEqual(result.sort(), ["alice", "bob", "charlie"]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: All tests PASS (16 total)

- [ ] **Step 3: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/rooms.test.ts
git commit -m "test: add @mention extraction tests"
```

---

### Task 5: Fix self-dedup bug in broadcastSSE

**Files:**
- Modify: `src/index.ts:122-133`

- [ ] **Step 1: Fix broadcastSSE to skip sender**

In `src/index.ts`, find the `broadcastSSE` function at line 122. Replace:

```typescript
function broadcastSSE(taskId: string, message: string, sender?: string, to?: string): void {
  const data = JSON.stringify({ task_id: taskId, message, sender, to });
  for (const sub of sseSubscribers) {
    // If "to" is specified, only send to that subscriber; otherwise broadcast to all
    if (to && sub.senderId && sub.senderId !== to) continue;
    try {
      sub.res.write(`data: ${data}\n\n`);
    } catch {
      sseSubscribers.delete(sub);
    }
  }
}
```

With:

```typescript
function broadcastSSE(taskId: string, message: string, sender?: string, to?: string): void {
  const data = JSON.stringify({ task_id: taskId, message, sender, to });
  for (const sub of sseSubscribers) {
    // If "to" is specified, only send to that subscriber; otherwise broadcast to all
    if (to && sub.senderId && sub.senderId !== to) continue;
    // Never echo back to sender (self-dedup)
    if (sender && sub.senderId && sub.senderId === sender) continue;
    try {
      sub.res.write(`data: ${data}\n\n`);
    } catch {
      sseSubscribers.delete(sub);
    }
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm run build`
Expected: compiles with zero errors

- [ ] **Step 3: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/index.ts
git commit -m "fix: add self-dedup to broadcastSSE — agents no longer receive their own tasks"
```

---

### Task 6: Wire RoomRegistry into index.ts — chat ACL enforcement

**Files:**
- Modify: `src/index.ts`

This is the core wiring task. It touches 5 locations in index.ts.

- [ ] **Step 1: Add import and instantiate RoomRegistry**

At the top of `src/index.ts`, after the existing imports (after line 18), add:

```typescript
import { RoomRegistry, extractMentions, OPEN_PERMISSION } from "./rooms.js";
```

After line 29 (`MACHINE_HEARTBEAT_MS`), add:

```typescript
const roomRegistry = new RoomRegistry();
roomRegistry.ensureRoom("general"); // backward compat: always have a "general" room
```

- [ ] **Step 2: Add `mentions` field to ChatMessage interface**

In `src/index.ts`, find the `ChatMessage` interface at line 57. Replace:

```typescript
interface ChatMessage {
  id: string;
  from: string;
  message: string;
  room: string;
  replyTo?: string; // id of message being replied to
  createdAt: number;
}
```

With:

```typescript
interface ChatMessage {
  id: string;
  from: string;
  message: string;
  room: string;
  replyTo?: string; // id of message being replied to
  mentions: string[]; // @mentioned agent names (without @)
  createdAt: number;
}
```

- [ ] **Step 3: Update addChatMessage to enforce write ACL and extract mentions**

Replace the `addChatMessage` function (line 69-83):

```typescript
function addChatMessage(from: string, message: string, room: string, replyTo?: string): ChatMessage {
  const msg: ChatMessage = {
    id: generateId(),
    from,
    message,
    room,
    replyTo,
    createdAt: Date.now(),
  };
  chatMessages.push(msg);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }
  return msg;
}
```

With:

```typescript
function addChatMessage(from: string, message: string, room: string, replyTo?: string): ChatMessage | null {
  roomRegistry.ensureRoom(room);
  if (!roomRegistry.canWrite(room, from)) return null;
  const msg: ChatMessage = {
    id: generateId(),
    from,
    message,
    room,
    replyTo,
    mentions: extractMentions(message),
    createdAt: Date.now(),
  };
  chatMessages.push(msg);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }
  return msg;
}
```

- [ ] **Step 4: Update broadcastChat to enforce read ACL and @mention filter**

Replace the `broadcastChat` function (line 135-146):

```typescript
function broadcastChat(msg: ChatMessage): void {
  const data = JSON.stringify({ type: "chat", ...msg });
  for (const sub of sseSubscribers) {
    // Don't echo back to sender
    if (sub.senderId === msg.from) continue;
    try {
      sub.res.write(`data: ${data}\n\n`);
    } catch {
      sseSubscribers.delete(sub);
    }
  }
}
```

With:

```typescript
function broadcastChat(msg: ChatMessage): void {
  const data = JSON.stringify({ type: "chat", ...msg });
  const hasMentions = msg.mentions.length > 0;
  for (const sub of sseSubscribers) {
    // Self-dedup: never echo back to sender (skip if senderId matches)
    if (sub.senderId && sub.senderId === msg.from) continue;
    // Anonymous subscribers (no senderId): deliver if room has no ACL restrictions
    if (!sub.senderId) {
      const roomObj = roomRegistry.get(msg.room);
      if (roomObj && roomObj.acl.size > 0) continue; // ACL-protected room, skip anonymous
      // Open room — deliver to anonymous (backward compat)
    } else {
      // ACL: only deliver to agents with read permission
      if (!roomRegistry.canRead(msg.room, sub.senderId)) continue;
      // @mention filter: if mentions exist, only deliver to mentioned agents
      if (hasMentions && !msg.mentions.includes(sub.senderId.toLowerCase())) continue;
    }
    try {
      sub.res.write(`data: ${data}\n\n`);
    } catch {
      sseSubscribers.delete(sub);
    }
  }
}
```

- [ ] **Step 5: Update POST /chat handler to check write ACL**

In the `POST /chat` handler (around line 1010-1058), replace:

```typescript
      const chatRoom = room || "general";
      const msg = addChatMessage(from, message, chatRoom, reply_to);

      // Push to local Claude Code session (if not from self)
      if (from !== SESSION_NAME) {
```

With:

```typescript
      const chatRoom = room || "general";
      const msg = addChatMessage(from, message, chatRoom, reply_to);

      if (!msg) {
        jsonResponse(res, 403, { error: `Agent "${from}" does not have write access to room "${chatRoom}"` });
        return;
      }

      // Push to local Claude Code session (if not from self)
      // Also check ACL + mention filter for local host delivery
      const hostCanRead = roomRegistry.canRead(chatRoom, SESSION_NAME);
      const hasMentions = msg.mentions.length > 0;
      const hostMentioned = !hasMentions || msg.mentions.includes(SESSION_NAME);
      if (from !== SESSION_NAME && hostCanRead && hostMentioned) {
```

- [ ] **Step 6: Update GET /chat handler to enforce history ACL**

Replace the `GET /chat` handler (around line 1062-1067):

```typescript
  // GET /chat — get chat history for a room
  if (req.method === "GET" && url.pathname === "/chat") {
    const room = url.searchParams.get("room") || "general";
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    jsonResponse(res, 200, { room, messages: getChatHistory(room, limit) });
    return;
  }
```

With:

```typescript
  // GET /chat — get chat history for a room
  if (req.method === "GET" && url.pathname === "/chat") {
    const room = url.searchParams.get("room") || "general";
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const agent = url.searchParams.get("agent");
    // If room has non-default ACL, require agent param for history access
    const roomObj = roomRegistry.get(room);
    if (roomObj && roomObj.acl.size > 0) {
      if (!agent) {
        jsonResponse(res, 400, { error: `Room "${room}" has ACL — "agent" query param is required for history access` });
        return;
      }
      if (!roomRegistry.canAccessHistory(room, agent)) {
        jsonResponse(res, 403, { error: `Agent "${agent}" does not have history access to room "${room}"` });
        return;
      }
    }
    jsonResponse(res, 200, { room, messages: getChatHistory(room, limit) });
    return;
  }
```

- [ ] **Step 7: Update relay_chat_history MCP tool to pass agent identity**

In the `relay_chat_history` handler (around line 715-740), update the URL construction:

```typescript
      const params = new URLSearchParams({
        room: room || "general",
        limit: String(limit || 50),
      });
```

To:

```typescript
      const params = new URLSearchParams({
        room: room || "general",
        limit: String(limit || 50),
        agent: SESSION_NAME,
      });
```

- [ ] **Step 8: Verify build**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm run build`
Expected: compiles with zero errors

- [ ] **Step 9: Run tests**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/index.ts
git commit -m "feat: wire RoomRegistry into chat — ACL enforcement, @mention routing, history access control"
```

---

### Task 7: New HTTP endpoints — room management

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add GET /rooms endpoint**

In `src/index.ts`, before the `jsonResponse(res, 404, ...)` line at the end of the HTTP handler (line 1179), add:

```typescript
  // GET /rooms — list all rooms with ACL
  if (req.method === "GET" && url.pathname === "/rooms") {
    jsonResponse(res, 200, {
      rooms: roomRegistry.list().map((r) => roomRegistry.serialize(r)),
    });
    return;
  }
```

- [ ] **Step 2: Add POST /rooms endpoint**

After the GET /rooms block, add:

```typescript
  // POST /rooms — create a room with optional ACL
  if (req.method === "POST" && url.pathname === "/rooms") {
    try {
      const body = await readBody(req);
      const config = JSON.parse(body) as {
        id: string;
        name?: string;
        created_by?: string;
        default_permission?: { read: boolean; write: boolean; history: boolean };
        acl?: Array<{ agent_id: string; read?: boolean; write?: boolean; history?: boolean }>;
      };

      if (!config.id) {
        jsonResponse(res, 400, { error: "Room ID is required" });
        return;
      }

      // Validate ACL entries have agent_id
      if (config.acl?.some((a) => !a.agent_id)) {
        jsonResponse(res, 400, { error: "Each ACL entry must have an agent_id" });
        return;
      }

      const room = roomRegistry.create({
        id: config.id,
        name: config.name || config.id,
        createdBy: config.created_by,
        defaultPermission: config.default_permission,
        acl: config.acl?.map((a) => ({
          agentId: a.agent_id,
          permission: {
            read: a.read ?? true,
            write: a.write ?? true,
            history: a.history ?? true,
          },
        })),
      });

      jsonResponse(res, 201, roomRegistry.serialize(room));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("already exists") || msg.includes("Invalid") ? 400 : 500;
      jsonResponse(res, status, { error: msg });
    }
    return;
  }
```

- [ ] **Step 3: Add PUT /rooms/:id/acl endpoint**

After the POST /rooms block, add:

```typescript
  // PUT /rooms/:id/acl — set per-agent permission
  const roomAclMatch = url.pathname.match(/^\/rooms\/([\w-]+)\/acl$/);
  if (req.method === "PUT" && roomAclMatch) {
    try {
      const roomId = roomAclMatch[1];
      const room = roomRegistry.get(roomId);
      if (!room) {
        jsonResponse(res, 404, { error: `Room "${roomId}" not found` });
        return;
      }
      const body = await readBody(req);
      const { agent_id, read, write, history } = JSON.parse(body) as {
        agent_id: string;
        read?: boolean;
        write?: boolean;
        history?: boolean;
      };
      if (!agent_id) {
        jsonResponse(res, 400, { error: "agent_id is required" });
        return;
      }
      roomRegistry.setAgentPermission(roomId, agent_id, {
        read: read ?? true,
        write: write ?? true,
        history: history ?? true,
      });
      jsonResponse(res, 200, roomRegistry.serialize(room));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: msg });
    }
    return;
  }
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm run build`
Expected: zero errors

- [ ] **Step 5: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/index.ts
git commit -m "feat: add GET/POST /rooms and PUT /rooms/:id/acl HTTP endpoints"
```

---

### Task 8: New MCP tools — room management

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add tool definitions to ListToolsRequestSchema handler**

In the `ListToolsRequestSchema` handler (line 320), add these tools to the `tools` array, after the `relay_chat_history` tool definition (before the closing `]`):

```typescript
    {
      name: "relay_create_room",
      description: [
        "Create a chat room with optional per-agent access control.",
        "Rooms auto-create with open permissions when first used, but this tool lets you set ACLs.",
        "Permissions: read (receive messages), write (send messages), history (access chat history).",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          room_id: {
            type: "string",
            description: "Room identifier — lowercase alphanumeric and dashes, e.g. 'ops', 'research-team'",
          },
          name: {
            type: "string",
            description: "Human-readable room name (defaults to room_id)",
          },
          default_permission: {
            type: "object",
            description: "Default permissions for agents not in the ACL (defaults to all true)",
            properties: {
              read: { type: "boolean" },
              write: { type: "boolean" },
              history: { type: "boolean" },
            },
          },
          acl: {
            type: "array",
            description: "Per-agent permission overrides",
            items: {
              type: "object",
              properties: {
                agent_id: { type: "string" },
                read: { type: "boolean" },
                write: { type: "boolean" },
                history: { type: "boolean" },
              },
              required: ["agent_id"],
            },
          },
        },
        required: ["room_id"],
      },
    },
    {
      name: "relay_list_rooms",
      description: "List all chat rooms with their access control settings.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "relay_set_room_permission",
      description: [
        "Set or update permissions for a specific agent in a room.",
        "Permissions: read (receive messages), write (send), history (access chat history).",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          room_id: {
            type: "string",
            description: "The room to modify",
          },
          agent_id: {
            type: "string",
            description: "The agent to set permissions for",
          },
          read: { type: "boolean", description: "Can receive messages (default: true)" },
          write: { type: "boolean", description: "Can send messages (default: true)" },
          history: { type: "boolean", description: "Can access chat history (default: true)" },
        },
        required: ["room_id", "agent_id"],
      },
    },
```

- [ ] **Step 2: Add tool handlers to CallToolRequestSchema handler**

In the `CallToolRequestSchema` handler, before the final `return { content: [{ type: "text", text: \`Error: Unknown tool...\` }] }` (around line 742), add:

```typescript
  // ── relay_create_room: POST to HTTP endpoint ──
  if (name === "relay_create_room") {
    const { room_id, name: roomName, default_permission, acl } = args as {
      room_id: string;
      name?: string;
      default_permission?: { read: boolean; write: boolean; history: boolean };
      acl?: Array<{ agent_id: string; read?: boolean; write?: boolean; history?: boolean }>;
    };
    try {
      const res = await fetch(`${RELAY_URL}/rooms`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          id: room_id,
          name: roomName,
          created_by: SESSION_NAME,
          default_permission,
          acl,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${(data as any).error || res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Room created:\n${JSON.stringify(data, null, 2)}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  // ── relay_list_rooms: GET from HTTP endpoint ──
  if (name === "relay_list_rooms") {
    try {
      const res = await fetch(`${RELAY_URL}/rooms`, { headers: authHeaders() });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  // ── relay_set_room_permission: PUT to HTTP endpoint ──
  if (name === "relay_set_room_permission") {
    const { room_id, agent_id, read, write, history } = args as {
      room_id: string;
      agent_id: string;
      read?: boolean;
      write?: boolean;
      history?: boolean;
    };
    try {
      const res = await fetch(`${RELAY_URL}/rooms/${encodeURIComponent(room_id)}/acl`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id, read, write, history }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${(data as any).error || res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Permission updated:\n${JSON.stringify(data, null, 2)}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm run build`
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/index.ts
git commit -m "feat: add relay_create_room, relay_list_rooms, relay_set_room_permission MCP tools"
```

---

### Task 9: Update /history and observer endpoints for room data

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add rooms to /history response**

Find the `GET /history` handler (around line 1144-1163). Replace:

```typescript
    jsonResponse(res, 200, { events: all, machines: getMachineList() });
```

With:

```typescript
    jsonResponse(res, 200, {
      events: all,
      machines: getMachineList(),
      rooms: roomRegistry.list().map((r) => roomRegistry.serialize(r)),
    });
```

- [ ] **Step 2: Add rooms to health check response**

Find the `GET /` handler (around line 782-792). Replace:

```typescript
    jsonResponse(res, 200, {
      name: "claude-relay",
      version: "2.0.0",
      session_name: SESSION_NAME,
      tasks_count: tasks.size,
      sse_subscribers: sseSubscribers.size,
      auth_required: !!RELAY_TOKEN,
    });
```

With:

```typescript
    jsonResponse(res, 200, {
      name: "claude-relay",
      version: "2.1.0",
      session_name: SESSION_NAME,
      tasks_count: tasks.size,
      sse_subscribers: sseSubscribers.size,
      rooms_count: roomRegistry.list().length,
      auth_required: !!RELAY_TOKEN,
    });
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm run build`
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/index.ts
git commit -m "feat: include rooms in /history and health check responses, bump to v2.1.0"
```

---

### Task 10: Integration tests for HTTP endpoints

**Files:**
- Create: `src/index.test.ts`

- [ ] **Step 1: Write integration tests**

Create `src/index.test.ts`:

```typescript
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";

const BASE = "http://127.0.0.1:8799"; // use non-default port to avoid conflicts
const TOKEN = "test-token-12345";

// We test the HTTP server directly by spawning the process
import { spawn, ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

let proc: ChildProcess;

async function waitForServer(url: string, maxMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Server did not start within ${maxMs}ms`);
}

describe("HTTP integration", () => {
  before(async () => {
    proc = spawn("npx", ["tsx", "src/index.ts"], {
      env: {
        ...process.env,
        RELAY_PORT: "8799",
        RELAY_TOKEN: TOKEN,
        RELAY_SESSION_NAME: "test-host",
      },
      stdio: "pipe",
    });
    await waitForServer(BASE);
  });

  after(() => {
    proc.kill();
  });

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  };

  it("GET / returns health with rooms_count", async () => {
    const res = await fetch(BASE);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.name, "claude-relay");
    assert.equal(typeof data.rooms_count, "number");
  });

  it("POST /rooms creates a room", async () => {
    const res = await fetch(`${BASE}/rooms`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "test-room",
        name: "Test Room",
        default_permission: { read: true, write: true, history: true },
        acl: [{ agent_id: "reader", read: true, write: false, history: false }],
      }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.id, "test-room");
  });

  it("POST /rooms rejects duplicate", async () => {
    const res = await fetch(`${BASE}/rooms`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "test-room", name: "Dup" }),
    });
    assert.equal(res.status, 400);
  });

  it("GET /rooms lists rooms", async () => {
    const res = await fetch(`${BASE}/rooms`, { headers });
    const data = (await res.json()) as { rooms: Array<Record<string, unknown>> };
    assert.ok(data.rooms.length >= 2); // "general" + "test-room"
    assert.ok(data.rooms.some((r) => r.id === "test-room"));
  });

  it("PUT /rooms/:id/acl updates permission", async () => {
    const res = await fetch(`${BASE}/rooms/test-room/acl`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agent_id: "writer", read: false, write: true, history: false }),
    });
    assert.equal(res.status, 200);
  });

  it("POST /chat respects write ACL", async () => {
    // "reader" agent has write: false on test-room
    const res = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: "reader", message: "should fail", room: "test-room" }),
    });
    assert.equal(res.status, 403);
  });

  it("POST /chat allows authorized write", async () => {
    const res = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: "writer", message: "hello @reader", room: "test-room" }),
    });
    assert.equal(res.status, 201);
  });

  it("GET /chat respects history ACL", async () => {
    // "reader" has history: false
    const res = await fetch(`${BASE}/chat?room=test-room&agent=reader`, { headers });
    assert.equal(res.status, 403);
  });

  it("GET /chat requires agent param for ACL-protected rooms", async () => {
    const res = await fetch(`${BASE}/chat?room=test-room`, { headers });
    assert.equal(res.status, 400); // ACL-protected room needs agent param
  });

  it("GET /chat allows history for authorized agent", async () => {
    // "writer" has full access
    const res = await fetch(`${BASE}/chat?room=test-room&agent=writer`, { headers });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { messages: unknown[] };
    assert.ok(data.messages.length >= 1);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: All unit tests + integration tests pass

- [ ] **Step 3: Commit**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add src/index.test.ts
git commit -m "test: add HTTP integration tests for rooms, ACL, and @mention routing"
```

---

### Task 11: Final build and manual verification

**Files:** None (verification only)

- [ ] **Step 1: Clean build**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm run clean && npm run build`
Expected: zero errors

- [ ] **Step 2: Run all tests**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && npm test`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test — start server and create a room**

Run: `cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server && RELAY_PORT=8799 RELAY_SESSION_NAME=smoke-test node dist/index.js &`
Then:
```bash
# Create a restricted room
curl -s -X POST http://127.0.0.1:8799/rooms \
  -H "Content-Type: application/json" \
  -d '{"id":"ops","name":"Operations","default_permission":{"read":true,"write":true,"history":true},"acl":[{"agent_id":"researcher","read":true,"write":false,"history":false}]}' | jq .

# List rooms
curl -s http://127.0.0.1:8799/rooms | jq .

# Verify researcher can't write
curl -s -X POST http://127.0.0.1:8799/chat \
  -H "Content-Type: application/json" \
  -d '{"from":"researcher","message":"test","room":"ops"}' | jq .
# Expected: 403

# Verify normal agent can write with @mention
curl -s -X POST http://127.0.0.1:8799/chat \
  -H "Content-Type: application/json" \
  -d '{"from":"ops-lead","message":"@researcher check this","room":"ops"}' | jq .
# Expected: 201

# Kill the server
kill %1
```

- [ ] **Step 4: Final commit if any adjustments needed**

```bash
cd /Users/glebkalinin/ai_projects/claude-relay-mcp-server
git add -A
git commit -m "chore: final adjustments after smoke test"
```
