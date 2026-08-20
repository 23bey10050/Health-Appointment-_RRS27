import { describe, expect, it } from 'vitest';

import { renderNotification } from '../../../src/modules/notifications/templates.js';
import type { RenderContext } from '../../../src/modules/notifications/render-context.js';

const baseContext: RenderContext = {
  appointmentId: 'appt-1',
  doctorId: 'doc-1',
  doctorName: 'Dr Anand Mehta',
  doctorEmail: 'mehta@clinic.test',
  doctorTimezone: 'Asia/Kolkata',
  doctorSpecialization: 'Cardiology',
  patientId: 'patient-1',
  patientName: 'Asha Verma',
  patientEmail: 'asha@example.test',
  patientTimezone: 'Europe/London',
  slot: { start: new Date('2026-09-01T09:00:00.000Z'), end: new Date('2026-09-01T09:20:00.000Z') },
  cancellationReason: null,
};

describe('renderNotification: booking_confirmation', () => {
  it("never doubles up the doctor's own honorific", () => {
    // The doctor's stored name already reads naturally ("Dr Anand Mehta") - the seed data and
    // every other part of the app display it exactly as stored, so a template must never prepend
    // its own "Dr." on top of it.
    const email = renderNotification('booking_confirmation', 'patient', baseContext);

    expect(email.subject).not.toMatch(/Dr\.\s+Dr\b/);
    expect(email.text).not.toMatch(/Dr\.\s+Dr\b/);
  });

  it("renders the patient's copy in the patient's own timezone", () => {
    const email = renderNotification('booking_confirmation', 'patient', baseContext);

    // 09:00 UTC is 10:00 in Europe/London during British Summer Time.
    expect(email.text).toContain('10:00');
    expect(email.text).toContain(baseContext.doctorSpecialization);
    expect(email.subject).toContain(baseContext.doctorName);
  });

  it("renders the doctor's copy in the doctor's own timezone, mentioning the patient", () => {
    const email = renderNotification('booking_confirmation', 'doctor', baseContext);

    // 09:00 UTC is 14:30 in Asia/Kolkata (UTC+5:30).
    expect(email.text).toContain('2:30 PM');
    expect(email.text).toContain(baseContext.patientName);
  });
});

describe('renderNotification: cancellation', () => {
  it('mentions the reason when one was given', () => {
    const email = renderNotification('cancellation', 'patient', {
      ...baseContext,
      cancellationReason: 'Feeling better',
    });

    expect(email.text).toContain('Feeling better');
  });

  it('reads cleanly with no reason at all, rather than an awkward blank', () => {
    const email = renderNotification('cancellation', 'patient', baseContext);

    expect(email.text).not.toContain('Reason given: ');
    expect(email.text).toContain('has been cancelled');
  });

  it("tells the doctor the slot is free again, which the patient's copy has no reason to say", () => {
    const patientCopy = renderNotification('cancellation', 'patient', baseContext);
    const doctorCopy = renderNotification('cancellation', 'doctor', baseContext);

    expect(doctorCopy.text).toContain('open again');
    expect(patientCopy.text).not.toContain('open again');
  });
});

describe('renderNotification: reminders', () => {
  it('a 24-hour reminder says "tomorrow"', () => {
    const email = renderNotification('reminder_24h', 'patient', baseContext);

    expect(email.subject).toContain('tomorrow');
  });

  it('a 1-hour reminder says roughly an hour, not "tomorrow"', () => {
    const email = renderNotification('reminder_1h', 'patient', baseContext);

    expect(email.subject).toContain('an hour');
    expect(email.subject).not.toContain('tomorrow');
  });
});

describe('renderNotification: not-yet-implemented types', () => {
  it('fails loudly for a type that has no template yet, rather than sending something wrong', () => {
    expect(() => renderNotification('leave_conflict', 'patient', baseContext)).toThrow(
      /No email template/,
    );
    expect(() => renderNotification('postvisit_summary', 'patient', baseContext)).toThrow(
      /No email template/,
    );
  });
});
