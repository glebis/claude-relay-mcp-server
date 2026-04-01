import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, closeDatabase } from "../store/db.js";
import { createChatStore } from "./chat.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/relay-chat-test.db";

describe("ChatStore", () => {
  let db: ReturnType<typeof createDatabase>;
  let store: ReturnType<typeof createChatStore>;

  before(() => {
    db = createDatabase(TEST_DB);
    store = createChatStore(db);
  });

  after(() => {
    closeDatabase(db);
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("adds a message", () => {
    const msg = store.add("gleb", "hello world", "general");
    assert.ok(msg.id);
    assert.equal(msg.from, "gleb");
    assert.equal(msg.room, "general");
  });

  it("retrieves history by room", () => {
    store.add("alice", "msg1", "dev");
    store.add("bob", "msg2", "dev");
    store.add("alice", "msg3", "random");
    const devHistory = store.getHistory("dev", 50);
    assert.equal(devHistory.length, 2);
    assert.equal(devHistory[0].from, "alice");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.add("bot", `msg-${i}`, "flood");
    }
    const limited = store.getHistory("flood", 3);
    assert.equal(limited.length, 3);
  });

  it("supports reply_to", () => {
    const original = store.add("alice", "question?", "general");
    const reply = store.add("bob", "answer!", "general", original.id);
    assert.equal(reply.reply_to, original.id);
  });
});
