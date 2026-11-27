"""Knowledge base as wiki: folders and edit time

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-27
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("knowledge_items", sa.Column("folder", sa.String(500), nullable=False, server_default=""))
    op.add_column("knowledge_items", sa.Column("updated_at", sa.DateTime(timezone=True)))
    op.create_index("ix_knowledge_items_folder", "knowledge_items", ["folder"])
    # встроенный пересказ критериев — в папку «Стандарты»
    op.execute("UPDATE knowledge_items SET folder = 'Стандарты' WHERE source = 'builtin'")


def downgrade() -> None:
    op.drop_index("ix_knowledge_items_folder", table_name="knowledge_items")
    op.drop_column("knowledge_items", "updated_at")
    op.drop_column("knowledge_items", "folder")
