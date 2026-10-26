ALTER TABLE students ADD COLUMN student_id TEXT;
ALTER TABLE students ADD COLUMN on_list INTEGER;
ALTER TABLE students ADD COLUMN list_name TEXT;
CREATE TABLE IF NOT EXISTS class_list (
  guild_id TEXT NOT NULL, student_id TEXT NOT NULL, last_name TEXT NOT NULL, first_name TEXT NOT NULL,
  middle_initial TEXT, suffix TEXT, section_code TEXT, PRIMARY KEY (guild_id, student_id)
);
CREATE TABLE IF NOT EXISTS pending (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, first_name TEXT NOT NULL, middle_name TEXT, last_name TEXT NOT NULL,
  suffix TEXT, email TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id)
);
