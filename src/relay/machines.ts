import type Database from "better-sqlite3";

const HEARTBEAT_TIMEOUT_MS = 90_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;

export interface Machine {
  name: string;
  mode: string;
  ip: string | null;
  last_seen: number;
  consecutive_failures: number;
  status: string;
  online: boolean;
}

export function createMachineStore(db: Database.Database) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO machines (name, mode, ip, last_seen, status)
      VALUES (?, ?, ?, ?, 'online')
      ON CONFLICT(name) DO UPDATE SET
        mode = excluded.mode,
        ip = COALESCE(excluded.ip, machines.ip),
        last_seen = excluded.last_seen
    `),
    listAll: db.prepare("SELECT * FROM machines ORDER BY name"),
    incrementFailures: db.prepare(`
      UPDATE machines SET
        consecutive_failures = consecutive_failures + 1,
        status = CASE WHEN consecutive_failures + 1 >= ? THEN 'degraded' ELSE status END
      WHERE name = ?
    `),
    resetFailures: db.prepare(`
      UPDATE machines SET consecutive_failures = 0, status = 'online' WHERE name = ?
    `),
    pruneStale: db.prepare(`DELETE FROM machines WHERE last_seen < ?`),
  };

  return {
    register(name: string, mode: string, ip?: string): void {
      stmts.upsert.run(name, mode, ip ?? null, Date.now());
    },

    list(): Machine[] {
      const now = Date.now();
      const rows = stmts.listAll.all() as Omit<Machine, "online">[];
      return rows.map((m) => ({
        ...m,
        online: now - m.last_seen < HEARTBEAT_TIMEOUT_MS,
      }));
    },

    recordFailure(name: string): void {
      stmts.incrementFailures.run(CIRCUIT_BREAKER_THRESHOLD, name);
    },

    recordSuccess(name: string): void {
      stmts.resetFailures.run(name);
    },

    pruneStale(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs;
      const res = stmts.pruneStale.run(cutoff);
      return res.changes as number;
    },
  };
}
