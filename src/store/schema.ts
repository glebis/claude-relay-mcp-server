export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sender TEXT,
        "to" TEXT,
        result TEXT,
        confidence REAL,
        review_mode TEXT DEFAULT 'auto',
        version INTEGER NOT NULL DEFAULT 1,
        revision_count INTEGER DEFAULT 0,
        idempotency_key TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        acked_at INTEGER,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        message TEXT NOT NULL,
        room TEXT NOT NULL DEFAULT 'general',
        reply_to TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS machines (
        name TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        ip TEXT,
        last_seen INTEGER NOT NULL,
        consecutive_failures INTEGER DEFAULT 0,
        status TEXT DEFAULT 'online'
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dead_letters (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        original_message TEXT,
        attempts INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_sender ON tasks(sender);
      CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room);
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
    `,
  },
];
