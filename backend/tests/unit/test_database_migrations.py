"""Tests for idempotent migration error handling in database.py."""

import sqlite3
import pytest
from unittest.mock import patch, MagicMock


def _run_migration(conn, sql):
    """Replicate the migration try/except logic from init_db_sync."""
    try:
        conn.execute(sql)
    except sqlite3.OperationalError as exc:
        msg = str(exc).lower()
        if 'duplicate column' in msg or 'already exists' in msg:
            pass  # expected idempotency case
        else:
            raise  # disk full, locked DB, malformed SQL — do not suppress


class TestMigrationErrorHandling:
    def setup_method(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute(
            "CREATE TABLE events (id TEXT PRIMARY KEY, camera TEXT NOT NULL)"
        )

    def teardown_method(self):
        self.conn.close()

    def test_already_exists_is_suppressed(self):
        """Adding a column that already exists raises no exception."""
        self.conn.execute("ALTER TABLE events ADD COLUMN zones TEXT")
        # Second attempt should be silently swallowed
        _run_migration(self.conn, "ALTER TABLE events ADD COLUMN zones TEXT")

    def test_duplicate_column_is_suppressed(self):
        """OperationalError with 'duplicate column' in message is suppressed."""
        exc = sqlite3.OperationalError("duplicate column name: zones")
        mock_conn = MagicMock()
        mock_conn.execute.side_effect = exc
        # Should not raise
        _run_migration(mock_conn, "ALTER TABLE events ADD COLUMN zones TEXT")

    def test_other_operational_error_is_reraised(self):
        """OperationalError unrelated to idempotency is re-raised."""
        exc = sqlite3.OperationalError("database is locked")
        mock_conn = MagicMock()
        mock_conn.execute.side_effect = exc
        with pytest.raises(sqlite3.OperationalError, match="database is locked"):
            _run_migration(mock_conn, "ALTER TABLE events ADD COLUMN zones TEXT")

    def test_malformed_sql_is_reraised(self):
        """OperationalError from malformed SQL is re-raised."""
        with pytest.raises(sqlite3.OperationalError):
            _run_migration(self.conn, "ALTER TABLE events ADD COLUMN")

    def test_successful_migration_adds_column(self):
        """A valid migration executes without error and the column is present."""
        _run_migration(self.conn, "ALTER TABLE events ADD COLUMN label TEXT")
        # Verify column exists by inserting into it
        self.conn.execute(
            "INSERT INTO events (id, camera, label) VALUES ('1', 'cam', 'person')"
        )
        row = self.conn.execute("SELECT label FROM events WHERE id='1'").fetchone()
        assert row[0] == "person"
