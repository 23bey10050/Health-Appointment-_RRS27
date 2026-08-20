import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { appointments } from '../../../src/db/schema.js';
import { loadRenderContext } from '../../../src/modules/notifications/render-context.js';
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

describe('loadRenderContext', () => {
  it('joins the doctor, patient, and slot a template needs', async () => {
    const doctorId = await createDoctor(database, {
      specialization: 'Cardiology',
      timezone: 'Asia/Kolkata',
    });
    const patientId = await createPatient(database, {
      fullName: 'Asha Verma',
      timezone: 'Europe/London',
    });
    const appointmentId = await createConfirmedAppointment(database, {
      doctorId,
      patientId,
      slot: slotAt(9),
    });

    const context = await loadRenderContext(database, appointmentId);

    expect(context).toMatchObject({
      appointmentId,
      doctorId,
      doctorSpecialization: 'Cardiology',
      doctorTimezone: 'Asia/Kolkata',
      patientId,
      patientName: 'Asha Verma',
      patientTimezone: 'Europe/London',
      cancellationReason: null,
    });
    expect(context?.slot.start.getTime()).toBe(slotAt(9).start.getTime());
  });

  it('includes the cancellation reason once the appointment is cancelled', async () => {
    const doctorId = await createDoctor(database);
    const patientId = await createPatient(database);
    const appointmentId = await createConfirmedAppointment(database, {
      doctorId,
      patientId,
      slot: slotAt(9),
    });

    await database.db
      .update(appointments)
      .set({ status: 'cancelled', cancellationReason: 'Feeling better' })
      .where(eq(appointments.id, appointmentId));

    const context = await loadRenderContext(database, appointmentId);

    expect(context?.cancellationReason).toBe('Feeling better');
  });

  it('returns undefined for an appointment id that does not exist', async () => {
    const context = await loadRenderContext(database, '00000000-0000-4000-8000-00000000ffff');

    expect(context).toBeUndefined();
  });
});
