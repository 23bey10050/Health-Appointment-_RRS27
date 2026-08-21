import { describe, expect, it } from 'vitest';

import { buildCalendarEventCopy } from '../../../src/modules/calendar/copy.js';
import type { RenderContext } from '../../../src/modules/notifications/render-context.js';
import { slotAt } from '../../helpers/fixtures.js';

const context: RenderContext = {
  appointmentId: 'appointment-1',
  doctorId: 'doctor-1',
  doctorName: 'Dr Anand Mehta',
  doctorEmail: 'mehta@clinic.test',
  doctorTimezone: 'UTC',
  doctorSpecialization: 'Cardiology',
  patientId: 'patient-1',
  patientName: 'Asha Verma',
  patientEmail: 'asha@example.test',
  patientTimezone: 'UTC',
  slot: slotAt(9),
  cancellationReason: null,
  googleEventIdPatient: null,
  googleEventIdDoctor: null,
};

describe('buildCalendarEventCopy', () => {
  it("does not double up the doctor's own honorific - the name already carries it", () => {
    const copy = buildCalendarEventCopy('patient', context);

    expect(copy.summary).toBe('Appointment with Dr Anand Mehta');
    expect(copy.summary).not.toContain('Dr. Dr');
  });

  it('gives the doctor a summary about their patient, not about themselves', () => {
    const copy = buildCalendarEventCopy('doctor', context);

    expect(copy.summary).toBe('Appointment with Asha Verma');
  });

  it('never puts the patient-reported symptoms into either side of the event', () => {
    const patientCopy = buildCalendarEventCopy('patient', context);
    const doctorCopy = buildCalendarEventCopy('doctor', context);

    expect(patientCopy.description).not.toMatch(/symptom/i);
    expect(doctorCopy.description).not.toMatch(/symptom/i);
  });
});
