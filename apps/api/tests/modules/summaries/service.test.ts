import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { appointments, auditLog } from '../../../src/db/schema.js';
import type { SummaryProvider } from '../../../src/modules/summaries/provider.js';
import {
  triggerPostvisitSummary,
  triggerPrevisitSummary,
} from '../../../src/modules/summaries/service.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import {
  createConfirmedAppointment,
  createDoctor,
  createPatient,
  slotAt,
} from '../../helpers/fixtures.js';

let database: Database;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
});

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function providerReturning(name: string, text: string): SummaryProvider {
  return { name, complete: vi.fn().mockResolvedValue(text) };
}

async function bookedAppointment(): Promise<string> {
  const doctorId = await createDoctor(database);
  const patientId = await createPatient(database);
  return createConfirmedAppointment(database, { doctorId, patientId, slot: slotAt(9) });
}

async function loadAppointment(appointmentId: string) {
  const [row] = await database.db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId));
  if (!row) {
    throw new Error('Appointment fixture went missing mid-test.');
  }
  return row;
}

describe('triggerPrevisitSummary', () => {
  it('writes the structured result onto the appointment once a provider answers', async () => {
    const appointmentId = await bookedAppointment();
    const groq = providerReturning(
      'groq',
      '{"urgency":"medium","chiefComplaint":"Persistent headache","suggestedQuestions":["How long has this lasted?"]}',
    );

    await triggerPrevisitSummary(
      database,
      appointmentId,
      'Headache for three days',
      [groq],
      silentLogger(),
    );

    const row = await loadAppointment(appointmentId);
    expect(row.aiPrevisitStatus).toBe('ready');
    expect(row.aiPrevisitProvider).toBe('groq');
    expect(row.aiUrgency).toBe('medium');
    expect(row.aiChiefComplaint).toBe('Persistent headache');
    expect(row.aiSuggestedQuestions).toEqual(['How long has this lasted?']);
  });

  it('falls back to the deterministic template when no provider is configured at all', async () => {
    const appointmentId = await bookedAppointment();

    await triggerPrevisitSummary(
      database,
      appointmentId,
      'Headache for three days',
      [],
      silentLogger(),
    );

    const row = await loadAppointment(appointmentId);
    expect(row.aiPrevisitStatus).toBe('unavailable');
    expect(row.aiChiefComplaint).toMatch(/could not be generated automatically/);
  });

  it('falls back to the template when every configured provider fails', async () => {
    const appointmentId = await bookedAppointment();
    const groq: SummaryProvider = {
      name: 'groq',
      complete: vi.fn().mockRejectedValue(new Error('down')),
    };

    await triggerPrevisitSummary(
      database,
      appointmentId,
      'Headache for three days',
      [groq],
      silentLogger(),
    );

    const row = await loadAppointment(appointmentId);
    expect(row.aiPrevisitStatus).toBe('unavailable');
  });

  it('still writes one audit entry when no provider is configured, so the trail is never silent', async () => {
    const appointmentId = await bookedAppointment();

    await triggerPrevisitSummary(database, appointmentId, 'Runny nose', [], silentLogger());

    const rows = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, appointmentId));
    const attemptRows = rows.filter((entry) => entry.action === 'previsit_summary_attempt');
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]?.metadata).toMatchObject({ outcome: 'no_provider_configured' });
  });

  it('logs one audit entry per attempt made', async () => {
    const appointmentId = await bookedAppointment();
    const groq: SummaryProvider = {
      name: 'groq',
      complete: vi.fn().mockRejectedValue(new Error('down')),
    };
    const gemini = providerReturning(
      'gemini',
      '{"urgency":"low","chiefComplaint":"Mild cold","suggestedQuestions":["Any fever?"]}',
    );

    await triggerPrevisitSummary(
      database,
      appointmentId,
      'Runny nose',
      [groq, gemini],
      silentLogger(),
    );

    const rows = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, appointmentId));
    const attemptRows = rows.filter((entry) => entry.action === 'previsit_summary_attempt');
    // Groq's first try, Groq's retry, then Gemini's one attempt.
    expect(attemptRows).toHaveLength(3);
  });

  it('never throws even when every write fails - a background call must not crash the server', async () => {
    const brokenDatabase = {
      ...database,
      db: {
        ...database.db,
        update: () => {
          throw new Error('connection lost');
        },
      },
    } as unknown as Database;

    await expect(
      triggerPrevisitSummary(brokenDatabase, 'not-a-real-id', 'symptoms', [], silentLogger()),
    ).resolves.toBeUndefined();
  });
});

describe('triggerPostvisitSummary', () => {
  it('writes the plain-language summary and steps once a provider answers', async () => {
    const appointmentId = await bookedAppointment();
    const groq = providerReturning(
      'groq',
      '{"summary":"You have a mild infection.","followUpSteps":["Rest for two days","Drink plenty of water"]}',
    );

    await triggerPostvisitSummary(
      database,
      appointmentId,
      'Diagnosed with a mild infection.',
      [groq],
      silentLogger(),
    );

    const row = await loadAppointment(appointmentId);
    expect(row.aiPostvisitStatus).toBe('ready');
    expect(row.aiPostvisitProvider).toBe('groq');
    expect(row.aiPostvisitSummary).toBe('You have a mild infection.');
    expect(row.aiPostvisitSteps).toEqual(['Rest for two days', 'Drink plenty of water']);
  });

  it('falls back to the deterministic template when no provider is configured at all', async () => {
    const appointmentId = await bookedAppointment();

    await triggerPostvisitSummary(
      database,
      appointmentId,
      'Some clinical notes.',
      [],
      silentLogger(),
    );

    const row = await loadAppointment(appointmentId);
    expect(row.aiPostvisitStatus).toBe('unavailable');
    expect(row.aiPostvisitSummary).toMatch(/could not be generated automatically/);
    expect(row.aiPostvisitSteps).toBeNull();
  });
});
