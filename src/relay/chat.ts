import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export interface ChatMessage {
  id: string;
  from: string;
  message: string;
  room: string;
  reply_to: string | null;
  created_at: number;
}

function generateId(): string {
  return randomBytes(6).toString("hex");
}

export function createChatStore(db: Database.Database) {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO chat_messages (id, "from", message, room, reply_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getHistory: db.prepare(`
      SELECT * FROM chat_messages WHERE room = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `),
    getById: db.prepare("SELECT * FROM chat_messages WHERE id = ?"),
  };

  return {
    add(from: string, message: string, room: string, replyTo?: string): ChatMessage {
      const id = generateId();
      const now = Date.now();
      stmts.insert.run(id, from, message, room, replyTo ?? null, now);
      return stmts.getById.get(id) as ChatMessage;
    },

    getHistory(room: string, limit: number = 50): ChatMessage[] {
      const rows = stmts.getHistory.all(room, limit) as ChatMessage[];
      return rows.reverse();
    },
  };
}
