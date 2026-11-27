"""Run log: agent events, core/worker logs and LLM calls per run

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-27
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "run_logs",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("level", sa.String(16), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("stage", sa.String(32)),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("current", sa.Integer),
        sa.Column("total", sa.Integer),
        sa.Column("data", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index("ix_run_logs_run_id_id", "run_logs", ["run_id", "id"])


def downgrade() -> None:
    op.drop_index("ix_run_logs_run_id_id", table_name="run_logs")
    op.drop_table("run_logs")
