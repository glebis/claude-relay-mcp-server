import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export type TaskStatus =
  | "pending"
  | "delivered"
  | "acked"
  | "in_progress"
  | "awaiting_review"
  | "approved"
  | "rejected"
  | "done"
  | "error"
  | "awaiting_permission";

export interface Task {
  id: string;
  message: string;
  status: TaskStatus;
  sender: string | null;
  to: string | null;
  result: string | null;
  confidence: number | null;
  review_mode: string;
  version: number;
  revision_count: number;
  idempotency_key: string | null;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
  completed_at: number | null;
}

export interface CreateTaskInput {
  message: string;
  sender?: string;
  to?: string;
  reviewMode?: string;
  idempotencyKey?: string;
}

function generateId(): string {
  return randomBytes(6).toString("hex");
}

export function createTaskStore(db: Database.Database) {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO tasks (id, message, status, sender, "to", review_mode, idempotency_key, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    `),
    getById: db.prepare("SELECT * FROM tasks WHERE id = ?"),
    getByIdempotencyKey: db.prepare("SELECT * FROM tasks WHERE idempotency_key = ?"),
    updateStatus: db.prepare(`
      UPDATE tasks SET status = ?, version = version + 1
      WHERE id = ? AND version = ?
    `),
    updateDelivered: db.prepare(`
      UPDATE tasks SET status = 'delivered', delivered_at = ?, version = version + 1
      WHERE id = ? AND version = ?
    `),
    updateComplete: db.prepare(`
      UPDATE tasks SET status = ?, result = ?, completed_at = ?, confidence = ?, version = version + 1
      WHERE id = ? AND version = ?
    `),
    listByStatus: db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC"),
    listAll: db.prepare("SELECT id, status, message, sender, created_at FROM tasks ORDER BY created_at DESC LIMIT 100"),
    cleanup: db.prepare("DELETE FROM tasks WHERE created_at < ?"),
  };

  return {
    create(input: CreateTaskInput): Task {
      if (input.idempotencyKey) {
        const existing = stmts.getByIdempotencyKey.get(input.idempotencyKey) as Task | undefined;
        if (existing) return existing;
      }
      const id = generateId();
      const now = Date.now();
      stmts.insert.run(id, input.message, input.sender ?? null, input.to ?? null, input.reviewMode ?? "auto", input.idempotencyKey ?? null, now);
      return stmts.getById.get(id) as Task;
    },

    get(id: string): Task | undefined {
      return stmts.getById.get(id) as Task | undefined;
    },

    updateStatus(id: string, status: TaskStatus, expectedVersion: number): Task {
      const result = stmts.updateStatus.run(status, id, expectedVersion);
      if (result.changes === 0) {
        const current = stmts.getById.get(id) as Task | undefined;
        if (!current) throw new Error(`Task ${id} not found`);
        throw new Error(`Version conflict: expected ${expectedVersion}, got ${current.version}`);
      }
      return stmts.getById.get(id) as Task;
    },

    markDelivered(id: string, expectedVersion: number): Task {
      const result = stmts.updateDelivered.run(Date.now(), id, expectedVersion);
      if (result.changes === 0) {
        const current = stmts.getById.get(id) as Task | undefined;
        if (!current) throw new Error(`Task ${id} not found`);
        throw new Error(`Version conflict: expected ${expectedVersion}, got ${current.version}`);
      }
      return stmts.getById.get(id) as Task;
    },

    complete(id: string, status: "done" | "error", result: string, expectedVersion: number, confidence?: number): Task {
      const res = stmts.updateComplete.run(status, result, Date.now(), confidence ?? null, id, expectedVersion);
      if (res.changes === 0) {
        const current = stmts.getById.get(id) as Task | undefined;
        if (!current) throw new Error(`Task ${id} not found`);
        throw new Error(`Version conflict: expected ${expectedVersion}, got ${current.version}`);
      }
      return stmts.getById.get(id) as Task;
    },

    listByStatus(status: TaskStatus): Task[] {
      return stmts.listByStatus.all(status) as Task[];
    },

    listAll(): Array<Pick<Task, "id" | "status" | "message" | "sender" | "created_at">> {
      return stmts.listAll.all() as any[];
    },

    cleanup(ttlHours: number): number {
      const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
      return stmts.cleanup.run(cutoff).changes;
    },
  };
}
