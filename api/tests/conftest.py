import os

os.environ.setdefault("SESSION_SECRET", "test-secret-test-secret-12345")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
