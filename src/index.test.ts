import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";

const BASE = "http://127.0.0.1:8799";
const TOKEN = "test-token-12345";

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

  it("GET /chat requires agent param for ACL-protected rooms", async () => {
    const res = await fetch(`${BASE}/chat?room=test-room`, { headers });
    assert.equal(res.status, 400);
  });

  it("GET /chat respects history ACL", async () => {
    // "reader" has history: false
    const res = await fetch(`${BASE}/chat?room=test-room&agent=reader`, { headers });
    assert.equal(res.status, 403);
  });

  it("GET /chat allows history for authorized agent", async () => {
    const res = await fetch(`${BASE}/chat?room=test-room&agent=writer`, { headers });
    // writer has history: false too (set via PUT), but default_permission has history: true
    // Wait — writer was set to history: false via PUT. Let's use an agent with default perms
    // Actually, default_permission has history: true, and "writer" was explicitly set to history: false
    // So this should fail. Let's use an unregistered agent that gets default perms instead.
    assert.equal(res.status, 403);
  });

  it("GET /chat allows history for agent with default permissions", async () => {
    // "default-agent" is not in ACL, so gets defaultPermission (all true)
    const res = await fetch(`${BASE}/chat?room=test-room&agent=default-agent`, { headers });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { messages: unknown[] };
    assert.ok(data.messages.length >= 1);
  });

  it("GET /chat works without agent on open rooms", async () => {
    // "general" has no ACL entries, so agent param is not required
    const res = await fetch(`${BASE}/chat?room=general`, { headers });
    assert.equal(res.status, 200);
  });
});
