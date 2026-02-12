DROP TABLE IF EXISTS file_tags;
DROP TABLE IF EXISTS files;

CREATE TABLE files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    size INTEGER,
    created_at INTEGER
);

CREATE TABLE file_tags (
    file_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (file_id, tag),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_files_filename ON files(filename);
CREATE INDEX idx_tags_tag ON file_tags(tag);
