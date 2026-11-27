"""Provider request options: extra_body, extra_body_set_review, max_output_tokens

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-27
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("provider_settings", sa.Column("extra_body", pg.JSONB))
    op.add_column("provider_settings", sa.Column("extra_body_set_review", pg.JSONB))
    op.add_column("provider_settings", sa.Column("max_output_tokens", sa.Integer))


def downgrade() -> None:
    for col in ("max_output_tokens", "extra_body_set_review", "extra_body"):
        op.drop_column("provider_settings", col)
