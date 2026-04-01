import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, closeDatabase } from "../store/db.js";
import { createTaskStore } from "./tasks.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/relay-tasks-test.db";

describe("TaskStore", () => {
  let db: ReturnType<typeof createDatabase>;
  let store: ReturnType<typeof createTaskStore>;

  before(() => {
    db = createDatabase(TEST_DB);
    store = createTaskStore(db);
  });

  after(() => {
    closeDatabase(db);
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("creates a task", () => {
    const task = store.create({ message: "do something", sender: "session-a" });
    assert.equal(task.status, "pending");
    assert.equal(task.version, 1);
    assert.ok(task.id);
  });

  it("retrieves a task by id", () => {
    const created = store.create({ message: "find me" });
    const found = store.get(created.id);
    assert.equal(found?.message, "find me");
  });

  it("updates task status with version check", () => {
    const task = store.create({ message: "version test" });
    const updated = store.updateStatus(task.id, "delivered", 1);
    assert.equal(updated?.status, "delivered");
    assert.equal(updated?.version, 2);
  });

  it("rejects update with wrong version", () => {
    const task = store.create({ message: "conflict test" });
    assert.throws(
      () => store.updateStatus(task.id, "delivered", 999),
      /version conflict/i
    );
  });

  it("completes a task with result", () => {
    const task = store.create({ message: "complete me" });
    store.updateStatus(task.id, "delivered", 1);
    const done = store.complete(task.id, "done", "the result", 2);
    assert.equal(done?.status, "done");
    assert.equal(done?.result, "the result");
  });

  it("deduplicates by idempotency key", () => {
    const task1 = store.create({ message: "first", idempotencyKey: "key-1" });
    const task2 = store.create({ message: "second", idempotencyKey: "key-1" });
    assert.equal(task1.id, task2.id);
  });

  it("cleans up expired tasks", () => {
    const old = store.create({ message: "old task" });
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?")
      .run(Date.now() - 100 * 60 * 60 * 1000, old.id);
    const cleaned = store.cleanup(8);
    assert.ok(cleaned > 0);
    assert.equal(store.get(old.id), undefined);
  });
});
