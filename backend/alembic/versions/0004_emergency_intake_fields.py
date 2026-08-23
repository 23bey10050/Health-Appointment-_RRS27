"""Emergency intake fields: ambulance dispatch + callback contact.

The voice agent now keeps the line open after escalating (orchestrator's
EMERGENCY tier) to ask whether an ambulance is needed and to capture a callback
name/number. Those answers belong on the case itself so the on-call doctor sees
them in the portal, not only in the voice transcript.

Revision ID: 0004
Revises: 0003
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("emergency_queue", sa.Column("ambulance_required", sa.Boolean(), nullable=True))
    op.add_column("emergency_queue", sa.Column("callback_name", sa.Text(), nullable=True))
    op.add_column("emergency_queue", sa.Column("callback_phone", sa.Text(), nullable=True))
    op.add_column(
        "emergency_queue",
        sa.Column("appointment_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_emergency_queue_appointment_id",
        "emergency_queue",
        "appointments",
        ["appointment_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # Partial index: the doctor portal's most urgent query is "which active cases
    # need an ambulance dispatched", and that set is tiny relative to the table.
    op.create_index(
        "ix_emergency_queue_ambulance_active",
        "emergency_queue",
        ["ambulance_required"],
        postgresql_where=sa.text("ambulance_required = true AND status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index("ix_emergency_queue_ambulance_active", table_name="emergency_queue")
    op.drop_constraint("fk_emergency_queue_appointment_id", "emergency_queue", type_="foreignkey")
    op.drop_column("emergency_queue", "appointment_id")
    op.drop_column("emergency_queue", "callback_phone")
    op.drop_column("emergency_queue", "callback_name")
    op.drop_column("emergency_queue", "ambulance_required")
