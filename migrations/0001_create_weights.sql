CREATE TABLE weights (
  measured_at_ms INTEGER PRIMARY KEY,
  kg REAL NOT NULL CHECK (kg > 0)
);
