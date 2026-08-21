import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { appointments } from '../../db/schema.js';

import type { CalendarSide } from './sync.js';

/** Records which Google Calendar event belongs to which side of an appointment, once a create
 *  actually succeeds - this is what a later cancellation looks up to know what to delete. */
export async function saveGoogleEventId(
  database: Database,
  appointmentId: string,
  side: CalendarSide,
  eventId: string,
): Promise<void> {
  if (side === 'patient') {
    await database.db
      .update(appointments)
      .set({ googleEventIdPatient: eventId })
      .where(eq(appointments.id, appointmentId));
  } else {
    await database.db
      .update(appointments)
      .set({ googleEventIdDoctor: eventId })
      .where(eq(appointments.id, appointmentId));
  }
}
