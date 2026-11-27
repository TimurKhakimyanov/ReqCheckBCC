"""Initial schema

Revision ID: 0001
Revises:
Create Date: 2026-11-27
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("username", sa.String(150), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("locale", sa.String(8), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_table(
        "provider_settings",
        sa.Column("provider", sa.String(32), primary_key=True),
        sa.Column("enabled", sa.Boolean, nullable=False),
        sa.Column("api_key_encrypted", sa.Text),
        sa.Column("key_hint", sa.String(16)),
        sa.Column("base_url", sa.String(500)),
        sa.Column("default_model", sa.String(200)),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_table(
        "documents",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("format", sa.String(8), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False, index=True),
        sa.Column("s3_key", sa.String(1000), nullable=False),
        sa.Column("created_at", TS, nullable=False, index=True),
    )
    op.create_table(
        "runs",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("document_id", pg.UUID(as_uuid=True), sa.ForeignKey("documents.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("status", sa.String(32), nullable=False, index=True),
        sa.Column("stage", sa.String(32), nullable=False),
        sa.Column("progress", sa.Float, nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("options", pg.JSONB, nullable=False),
        sa.Column("task_id", sa.String(64)),
        sa.Column("created_at", TS, nullable=False, index=True),
        sa.Column("started_at", TS),
        sa.Column("finished_at", TS),
        sa.Column("error", sa.Text),
        sa.Column("usage", pg.JSONB),
        sa.Column("summary", pg.JSONB),
    )
    op.create_table(
        "reports",
        sa.Column("run_id", pg.UUID(as_uuid=True), sa.ForeignKey("runs.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("data", pg.JSONB, nullable=False),
        sa.Column("artifacts", pg.JSONB, nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "finding_reviews",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("run_id", pg.UUID(as_uuid=True), sa.ForeignKey("runs.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("finding_id", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("comment", sa.Text),
        sa.Column("updated_at", TS, nullable=False),
        sa.UniqueConstraint("run_id", "finding_id"),
    )
    op.create_table(
        "chat_messages",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("run_id", pg.UUID(as_uuid=True), sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("provider", sa.String(32)),
        sa.Column("model", sa.String(200)),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_chat_messages_run_created", "chat_messages", ["run_id", "created_at"])
    op.create_table(
        "knowledge_items",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("chunks", sa.Integer, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error", sa.Text),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("ts", TS, nullable=False, index=True),
        sa.Column("actor", sa.String(150), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("target", sa.String(500)),
        sa.Column("details", pg.JSONB, nullable=False),
        sa.Column("ip", sa.String(64)),
    )


def downgrade() -> None:
    for table in ("audit_log", "knowledge_items", "chat_messages", "finding_reviews", "reports", "runs",
                  "documents", "provider_settings", "users"):
        op.drop_table(table)
