import {DatabaseSync} from 'node:sqlite';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        sent_at INTEGER, message_id TEXT);
      CREATE TABLE IF NOT EXISTS process_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER NOT NULL);`);
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue(id, text, now = Date.now()) {
    this.db.prepare('INSERT INTO outbox(id,text,created_at,next_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id, text, now, now);
  }
  saveCheck(memory, messages, checkedAt = Date.now()) {
    this.atomic(() => {
      this.set('memory', memory);
      this.set('lastCheckAt', checkedAt);
      for (const message of messages) this.enqueue(message.id, message.text, checkedAt);
      this.db.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?').run(checkedAt - 30 * 86400000);
    });
  }
  nextMessage(now = Date.now()) {
    // Preserve delivery order, including when the oldest item is backing off.
    const row = this.db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY created_at,rowid LIMIT 1').get();
    return row && row.next_at <= now ? row : null;
  }
  sent(id, messageId, now = Date.now()) {
    this.atomic(() => {
      this.db.prepare('UPDATE outbox SET sent_at=?,message_id=? WHERE id=? AND sent_at IS NULL').run(now, String(messageId), id);
      this.set('lastAcceptedByTelegramAt', now);
    });
  }
  retry(id, nextAt) {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,next_at=? WHERE id=? AND sent_at IS NULL').run(nextAt, id);
  }
  pendingCount() { return this.db.prepare('SELECT count(*) AS n FROM outbox WHERE sent_at IS NULL').get().n; }
  lease(owner, now = Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO process_lock(id,owner,until_ms) VALUES(1,NULL,0)').run();
    return this.db.prepare('UPDATE process_lock SET owner=?,until_ms=? WHERE id=1 AND (owner=? OR until_ms < ?)')
      .run(owner, now + 90000, owner, now).changes === 1;
  }
  release(owner) { this.db.prepare('UPDATE process_lock SET until_ms=0 WHERE owner=?').run(owner); }
  close() { this.db.close(); }
}
