import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.js";

export function createDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);

  const currentVersion = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null };

  const applied = currentVersion?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > applied) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      console.error(`claude-relay: applied migration v${migration.version}`);
    }
  }

  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
