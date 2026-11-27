"""App settings table; drop the implicit Ollama URL default

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-27
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("data", pg.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("embeddings_api_key_encrypted", sa.Text),
        sa.Column("embeddings_key_hint", sa.String(16)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("INSERT INTO app_settings (id, data) VALUES (1, '{}'::jsonb)")
    # Раньше адрес Ollama подставлялся по умолчанию; теперь openai_compatible пуст, пока админ не задаст сервер.
    op.execute("UPDATE provider_settings SET base_url = NULL "
               "WHERE provider = 'openai_compatible' AND base_url = 'http://ollama:11434/v1'")


def downgrade() -> None:
    op.drop_table("app_settings")
