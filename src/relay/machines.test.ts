import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, closeDatabase } from "../store/db.js";
import { createMachineStore } from "./machines.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/relay-machines-test.db";

describe("MachineStore", () => {
  let db: ReturnType<typeof createDatabase>;
  let store: ReturnType<typeof createMachineStore>;

  before(() => {
    db = createDatabase(TEST_DB);
    store = createMachineStore(db);
  });

  after(() => {
    closeDatabase(db);
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("registers a machine", () => {
    store.register("mac-mini", "client", "100.97.18.14");
    const list = store.list();
    const machine = list.find((m) => m.name === "mac-mini");
    assert.ok(machine);
    assert.equal(machine.mode, "client");
    assert.equal(machine.online, true);
  });

  it("detects offline machines", () => {
    store.register("old-machine", "client", "1.2.3.4");
    db.prepare("UPDATE machines SET last_seen = ? WHERE name = ?")
      .run(Date.now() - 200_000, "old-machine");
    const list = store.list();
    const machine = list.find((m) => m.name === "old-machine");
    assert.equal(machine?.online, false);
  });

  it("tracks consecutive failures", () => {
    store.register("flaky", "client");
    store.recordFailure("flaky");
    store.recordFailure("flaky");
    store.recordFailure("flaky");
    const list = store.list();
    const machine = list.find((m) => m.name === "flaky");
    assert.equal(machine?.status, "degraded");
  });

  it("resets failures on success", () => {
    store.register("recovered", "client");
    store.recordFailure("recovered");
    store.recordFailure("recovered");
    store.recordFailure("recovered");
    store.recordSuccess("recovered");
    const list = store.list();
    const machine = list.find((m) => m.name === "recovered");
    assert.equal(machine?.consecutive_failures, 0);
    assert.equal(machine?.status, "online");
  });
});
