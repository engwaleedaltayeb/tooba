CREATE TABLE IF NOT EXISTS subs (
  endpoint TEXT PRIMARY KEY,
  m_time   TEXT,
  e_time   TEXT,
  tz       TEXT NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_tz_m ON subs(tz, m_time);
CREATE INDEX IF NOT EXISTS idx_subs_tz_e ON subs(tz, e_time);
CREATE TABLE IF NOT EXISTS tzs (tz TEXT PRIMARY KEY);
