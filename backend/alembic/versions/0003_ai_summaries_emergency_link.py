"""ai_summaries.emergency_queue_id -- section 6.3's ai_summaries table predates
emergency_queue (migration 0002, itself an addition for section 6.2's own
"prefer a dedicated emergency_queue table" note), so it has no way to link an
emergency_brief summary back to the case it was generated for. appointment_id and
encounter_id don't fit: an emergency escalation deliberately bypasses the
appointments table entirely (see 0002's docstring).

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-23

"""

from typing import Sequence, Union

from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ai_summaries ADD COLUMN emergency_queue_id UUID REFERENCES emergency_queue(id) ON DELETE CASCADE;"
    )
    op.execute("CREATE INDEX ON ai_summaries (emergency_queue_id) WHERE emergency_queue_id IS NOT NULL;")


def downgrade() -> None:
    op.execute("ALTER TABLE ai_summaries DROP COLUMN IF EXISTS emergency_queue_id;")
