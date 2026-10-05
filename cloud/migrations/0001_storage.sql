CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  previous_json TEXT NOT NULL,
  commit_id TEXT NOT NULL
);
CREATE TABLE cycle_backups (
  month TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  previous_json TEXT NOT NULL
);

CREATE TABLE receipts (
  month TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  data_url TEXT NOT NULL,
  PRIMARY KEY (month, id)
);
