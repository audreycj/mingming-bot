-- Mingming database (Cloudflare D1, which is SQLite under the hood)

-- One row per Discord server (course)
CREATE TABLE IF NOT EXISTS servers (
  guild_id        TEXT PRIMARY KEY,
  course_name     TEXT NOT NULL,
  student_role_id TEXT NOT NULL,
  name_format     TEXT NOT NULL DEFAULT 'first_last'
);

-- Sections per server. Removed sections are kept as "retired" (active = 0),
-- so Mingming still knows to strip their roles when a student re-registers.
CREATE TABLE IF NOT EXISTS sections (
  guild_id TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  label    TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  emoji    TEXT,
  PRIMARY KEY (guild_id, role_id)
);

-- One row per registered student per server
CREATE TABLE IF NOT EXISTS students (
  guild_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  username        TEXT,
  first_name      TEXT NOT NULL,
  middle_name     TEXT,
  last_name       TEXT NOT NULL,
  suffix          TEXT,
  email           TEXT NOT NULL,
  section         TEXT,
  section_role_id TEXT,
  student_id      TEXT,
  on_list         INTEGER,   -- 1 on the list, 2 on the list but name spelled differently, 0 not found
  list_name       TEXT,      -- the class list's spelling, when it differs from the student's
  registered_at   TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- Optional class list per server, used to verify students and assign their section
CREATE TABLE IF NOT EXISTS class_list (
  guild_id       TEXT NOT NULL,
  student_id     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  first_name     TEXT NOT NULL,
  middle_initial TEXT,
  suffix         TEXT,
  section_code   TEXT,
  PRIMARY KEY (guild_id, student_id)
);

-- A registration waiting for the student to confirm (not found on the class list)
CREATE TABLE IF NOT EXISTS pending (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  first_name  TEXT NOT NULL,
  middle_name TEXT,
  last_name   TEXT NOT NULL,
  suffix      TEXT,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- Short-lived lock: one registration at a time per student
CREATE TABLE IF NOT EXISTS in_progress (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
