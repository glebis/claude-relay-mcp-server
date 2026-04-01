import type Database from "better-sqlite3";

export interface AuditEntry {
  taskId?: string;
  actor: string;
  action: string;
  payload?: Record<string, unknown>;
}

export function createAuditLogger(db: Database.Database) {
  const insert = db.prepare(`
    INSERT INTO audit_log (task_id, actor, action, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  return {
    log(entry: AuditEntry): void {
      insert.run(
        entry.taskId ?? null,
        entry.actor,
        entry.action,
        entry.payload ? JSON.stringify(entry.payload) : null,
        Date.now()
      );
    },

    getForTask(taskId: string): Array<{
      actor: string;
      action: string;
      payload: string | null;
      created_at: number;
    }> {
      return db
        .prepare("SELECT actor, action, payload, created_at FROM audit_log WHERE task_id = ? ORDER BY created_at")
        .all(taskId) as any[];
    },
  };
}
