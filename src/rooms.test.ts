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
    assert.equal(r1, r2);
  });

  it("applies per-agent permissions over defaults", () => {
    const registry = new RoomRegistry();
    registry.create({
      id: "ops",
      name: "Ops",
      defaultPermission: OPEN_PERMISSION,
      acl: [{ agentId: "researcher", permission: READ_ONLY }],
    });
    assert.equal(registry.canRead("ops", "researcher"), true);
    assert.equal(registry.canWrite("ops", "researcher"), false);
    assert.equal(registry.canAccessHistory("ops", "researcher"), false);
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
});

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
