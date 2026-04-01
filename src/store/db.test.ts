import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, closeDatabase } from "./db.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/relay-test.db";

describe("SQLite Store", () => {
  after(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("creates database with WAL mode", () => {
    const db = createDatabase(TEST_DB);
    const mode = db.pragma("journal_mode", { simple: true });
    assert.equal(mode, "wal");
    closeDatabase(db);
  });

  it("creates all required tables", () => {
    const db = createDatabase(TEST_DB);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    assert.ok(tables.includes("tasks"));
    assert.ok(tables.includes("chat_messages"));
    assert.ok(tables.includes("machines"));
    assert.ok(tables.includes("audit_log"));
    assert.ok(tables.includes("dead_letters"));
    closeDatabase(db);
  });

  it("inserts and retrieves a task", () => {
    const db = createDatabase(TEST_DB);
    db.prepare(
      `INSERT INTO tasks (id, message, status, created_at) VALUES (?, ?, ?, ?)`
    ).run("test1", "hello", "pending", Date.now());
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get("test1") as any;
    assert.equal(task.message, "hello");
    assert.equal(task.status, "pending");
    assert.equal(task.version, 1);
    closeDatabase(db);
  });
});
