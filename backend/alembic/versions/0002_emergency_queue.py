"""emergency_queue -- IMPLEMENTATION.md section 6.2's own note under the exclusion
constraint: emergency cases need a home outside appointments' doctor+slot exclusion
logic entirely ("...emergency appointments are exempt from the exclusion constraint
by being written with a zero-length range or a dedicated emergency_queue table --
prefer the latter; do not weaken the constraint"). An emergency is "get this
patient to care now", not a scheduled slot, so it was never a good fit for a table
whose whole job is one-doctor-one-slot-at-a-time.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-23

"""

from typing import Sequence, Union

from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE TYPE emergency_queue_status AS ENUM ('active','acknowledged','resolved');"
    )
    op.execute(
        """
        CREATE TABLE emergency_queue (
          id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          patient_id        UUID REFERENCES users(id),
          hospital_id       UUID REFERENCES hospitals(id),
          voice_session_id  UUID REFERENCES voice_sessions(id),
          category          TEXT NOT NULL,
          severity          TEXT NOT NULL,
          summary           TEXT,
          status            emergency_queue_status NOT NULL DEFAULT 'active',
          oncall_doctor_id  UUID REFERENCES users(id),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          acknowledged_at   TIMESTAMPTZ,
          resolved_at       TIMESTAMPTZ
        );
        """
    )
    op.execute("CREATE INDEX ON emergency_queue (status, created_at DESC);")
    op.execute("CREATE INDEX ON emergency_queue (hospital_id, status);")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS emergency_queue CASCADE;")
    op.execute("DROP TYPE IF EXISTS emergency_queue_status;")
