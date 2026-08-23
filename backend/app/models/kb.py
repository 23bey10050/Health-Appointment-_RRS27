import uuid
from datetime import date, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, Computed, Date, ForeignKey, Integer, Text, func, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._types import pg_enum
from app.models.enums import KBAudience, KBNamespace

EMBEDDING_DIM = 384  # bge-small-en-v1.5


class KBDocument(Base):
    __tablename__ = "kb_documents"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    namespace: Mapped[KBNamespace] = mapped_column(pg_enum(KBNamespace, "kb_namespace"), nullable=False)
    audience: Mapped[KBAudience] = mapped_column(pg_enum(KBAudience, "kb_audience"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    source_uri: Mapped[str | None] = mapped_column(Text)
    source_type: Mapped[str | None] = mapped_column(Text)  # policy|protocol|doctor_profile|guideline|faq
    patient_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    effective_from: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )

    chunks: Mapped[list["KBChunk"]] = relationship(back_populates="document", cascade="all, delete-orphan")


class KBChunk(Base):
    __tablename__ = "kb_chunks"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False
    )
    namespace: Mapped[KBNamespace] = mapped_column(
        pg_enum(KBNamespace, "kb_namespace"), nullable=False
    )  # denormalised for fast filtering
    audience: Mapped[KBAudience] = mapped_column(pg_enum(KBAudience, "kb_audience"), nullable=False)
    patient_id: Mapped[uuid.UUID | None] = mapped_column(postgresql.UUID(as_uuid=True))
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    heading_path: Mapped[str | None] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM), nullable=False)
    tsv: Mapped[str] = mapped_column(
        postgresql.TSVECTOR, Computed("to_tsvector('english', content)", persisted=True)
    )
    token_count: Mapped[int | None] = mapped_column(Integer)

    document: Mapped["KBDocument"] = relationship(back_populates="chunks")
