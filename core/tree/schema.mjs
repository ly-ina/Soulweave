// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/schema.mjs —— 树索引的四张表（frag / summary / kw / kw_link）。
 *
 * 落库位置：魂织自己的 `soul-memory.db`（同库不同表），不建独立库。
 * 原文全文仍在会话文件 / `soul.db` 里；frag 只存切块后的短文本与定位坐标，
 * 所以任何一层坏了都能从下一层重建。
 *
 * 幂等：全部 IF NOT EXISTS，老库直接跑不伤数据。
 */

export const TREE_SCHEMA_VERSION = 2

export function ensureTreeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS frag (
      id TEXT PRIMARY KEY,          -- sid:seq:idx
      sid TEXT NOT NULL,
      seq INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      role TEXT,
      t INTEGER,
      len INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS frag_sid ON frag(sid, seq, idx);
    CREATE INDEX IF NOT EXISTS frag_t ON frag(t);

    CREATE TABLE IF NOT EXISTS summary (
      id TEXT PRIMARY KEY,          -- sid:t<turn>
      sid TEXT NOT NULL,
      turn INTEGER NOT NULL,
      zone TEXT NOT NULL DEFAULT 'misc',
      layer TEXT NOT NULL DEFAULT 'search',
      text TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'extractive-v1',
      src_len INTEGER NOT NULL DEFAULT 0,
      t INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS summary_zone ON summary(zone, layer);
    CREATE INDEX IF NOT EXISTS summary_sid ON summary(sid, turn);

    CREATE TABLE IF NOT EXISTS frag_summary (
      frag_id TEXT NOT NULL,
      summary_id TEXT NOT NULL,
      PRIMARY KEY (frag_id, summary_id)
    );
    CREATE INDEX IF NOT EXISTS frag_summary_s ON frag_summary(summary_id);

    CREATE TABLE IF NOT EXISTS kw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL,
      scene TEXT NOT NULL DEFAULT '',
      df INTEGER NOT NULL DEFAULT 0,
      UNIQUE(term, scene)
    );
    CREATE INDEX IF NOT EXISTS kw_term ON kw(term);

    CREATE TABLE IF NOT EXISTS kw_link (
      summary_id TEXT NOT NULL,
      kw_id INTEGER NOT NULL,
      tf INTEGER NOT NULL DEFAULT 1,
      weight REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (summary_id, kw_id)
    );
    CREATE INDEX IF NOT EXISTS kw_link_kw ON kw_link(kw_id);

    -- 句子级向量只挂在 summary 上（实测裸词向量没有区分度，不建词级向量）
    CREATE TABLE IF NOT EXISTS summary_vec (
      summary_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tree_meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    -- SPEC-V2 §1：每次工具调用一行情景坐标（同库，和树索引一起搬/一起备份）
    CREATE TABLE IF NOT EXISTS scene (
      id TEXT PRIMARY KEY,          -- sid:seq
      sid TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      turn INTEGER NOT NULL DEFAULT 0,
      step INTEGER NOT NULL DEFAULT 0,
      tool TEXT,
      cwd TEXT NOT NULL DEFAULT '',
      path_pattern TEXT NOT NULL DEFAULT '',
      time_window TEXT NOT NULL DEFAULT '',
      intimacy REAL NOT NULL DEFAULT 0,
      tool_ms_window INTEGER NOT NULL DEFAULT 0,
      tool_count INTEGER NOT NULL DEFAULT 0,
      t INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scene_sid ON scene(sid, seq);
    CREATE INDEX IF NOT EXISTS scene_tool ON scene(tool, path_pattern);
    CREATE INDEX IF NOT EXISTS scene_t ON scene(t);
  `)
  // 老库补列：summary.scene_id（SQLite 的 ADD COLUMN 只能一条条来）
  const summaryCols = db.prepare('PRAGMA table_info(summary)').all().map((c) => c.name)
  if (!summaryCols.includes('scene_id')) db.exec('ALTER TABLE summary ADD COLUMN scene_id TEXT')
  db.prepare('INSERT INTO tree_meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('schema_version', String(TREE_SCHEMA_VERSION))
}

/** 读树的规模，给工具和自检用。 */
export function treeStats(db) {
  const one = (sql) => {
    try { return db.prepare(sql).get()?.n ?? 0 } catch { return 0 }
  }
  return {
    frag: one('SELECT COUNT(*) n FROM frag'),
    summary: one('SELECT COUNT(*) n FROM summary'),
    kw: one('SELECT COUNT(*) n FROM kw'),
    link: one('SELECT COUNT(*) n FROM kw_link'),
    vec: one('SELECT COUNT(*) n FROM summary_vec'),
    scene: one('SELECT COUNT(*) n FROM scene'),
  }
}
