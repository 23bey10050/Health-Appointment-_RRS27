import {
  appointmentSchema,
  cancelAppointmentRequestSchema,
  confirmRequestSchema,
  holdRequestSchema,
  holdResponseSchema,
  submitNotesRequestSchema,
  type Appointment,
  type CancelAppointmentRequest,
  type HoldResponse,
} from '@health/contracts';
import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { requireRole, requireUser } from '../auth/guards.js';
import * as summaryService from '../summaries/service.js';

import type { AppointmentDetail, HoldRow } from './repository.js';
import * as appointmentService from './service.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const holdIdParamSchema = z.object({ holdId: z.string().uuid() });

function toHoldResponse(hold: HoldRow): HoldResponse {
  return {
    holdId: hold.id,
    doctorId: hold.doctorId,
    start: hold.slot.start.toISOString(),
    end: hold.slot.end.toISOString(),
    expiresAt: hold.expiresAt.toISOString(),
  };
}

function toAppointment(detail: AppointmentDetail): Appointment {
  return {
    id: detail.id,
    doctorId: detail.doctorId,
    doctorName: detail.doctorName,
    patientId: detail.patientId,
    patientName: detail.patientName,
    start: detail.slot.start.toISOString(),
    end: detail.slot.end.toISOString(),
    status: detail.status,
    symptoms: detail.symptoms,
    createdAt: detail.createdAt.toISOString(),
    aiPrevisitStatus: detail.aiPrevisitStatus,
    aiUrgency: detail.aiUrgency,
    aiChiefComplaint: detail.aiChiefComplaint,
    aiSuggestedQuestions: detail.aiSuggestedQuestions,
    doctorNotes: detail.doctorNotes,
    prescription: detail.prescription,
    aiPostvisitStatus: detail.aiPostvisitStatus,
    aiPostvisitSummary: detail.aiPostvisitSummary,
    aiPostvisitSteps: detail.aiPostvisitSteps,
  };
}

/**
 * A DELETE request is not required to carry a body, so its schema is not declared through
 * Fastify's `schema.body` the way every other route here is — that would reject the very common
 * case of a client sending no body at all. The optional reason is parsed by hand instead, and an
 * invalid one is simply treated as "no reason given" rather than failing the whole cancellation.
 */
function readCancelReason(body: unknown): string | undefined {
  const parsed = cancelAppointmentRequestSchema.safeParse(body ?? {});
  return parsed.success ? parsed.data.reason : undefined;
}

export const appointmentRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.post(
    '/hold',
    {
      preHandler: requireRole('patient'),
      schema: { body: holdRequestSchema, response: { 201: holdResponseSchema } },
    },
    async (request, reply) => {
      const hold = await appointmentService.holdSlot(
        request.server.db,
        requireUser(request).id,
        request.body.doctorId,
        new Date(request.body.start),
      );
      return reply.status(201).send(toHoldResponse(hold));
    },
  );

  app.post(
    '/:holdId/confirm',
    {
      preHandler: requireRole('patient'),
      schema: {
        params: holdIdParamSchema,
        body: confirmRequestSchema,
        response: { 201: appointmentSchema },
      },
    },
    async (request, reply) => {
      const appointment = await appointmentService.confirmHold(
        request.server.db,
        requireUser(request).id,
        request.params.holdId,
        request.body.symptoms,
      );

      // Fired after the response is already on its way, not awaited - a slow AI call must never
      // make booking itself feel slow. triggerPrevisitSummary swallows its own errors, so there is
      // nothing here for a rejection to bubble up from.
      void summaryService.triggerPrevisitSummary(
        request.server.db,
        appointment.id,
        request.body.symptoms,
        request.server.summaryProviders,
        request.log,
      );

      return reply.status(201).send(toAppointment(appointment));
    },
  );

  app.get(
    '/mine',
    {
      preHandler: requireRole('patient'),
      schema: { response: { 200: z.array(appointmentSchema) } },
    },
    async (request, reply) => {
      const mine = await appointmentService.listMyAppointments(
        request.server.db,
        requireUser(request).id,
      );
      return reply.status(200).send(mine.map(toAppointment));
    },
  );

  app.get(
    '/:id',
    {
      // A doctor can read their own side of this too, as of this phase - they need it to see the
      // pre-visit triage brief before the appointment starts.
      preHandler: requireRole('patient', 'doctor', 'admin'),
      schema: { params: idParamSchema, response: { 200: appointmentSchema } },
    },
    async (request, reply) => {
      const appointment = await appointmentService.getAppointment(
        request.server.db,
        requireUser(request),
        request.params.id,
      );
      return reply.status(200).send(toAppointment(appointment));
    },
  );

  app.post(
    '/:id/notes',
    {
      preHandler: requireRole('doctor'),
      schema: {
        params: idParamSchema,
        body: submitNotesRequestSchema,
        response: { 200: appointmentSchema },
      },
    },
    async (request, reply) => {
      const appointment = await appointmentService.submitNotes(
        request.server.db,
        requireUser(request).id,
        request.params.id,
        request.body.doctorNotes,
        request.body.prescription,
      );

      void summaryService.triggerPostvisitSummary(
        request.server.db,
        appointment.id,
        request.body.doctorNotes,
        request.server.summaryProviders,
        request.log,
      );

      return reply.status(200).send(toAppointment(appointment));
    },
  );

  app.delete(
    '/:id',
    { preHandler: requireRole('patient', 'admin'), schema: { params: idParamSchema } },
    async (request, reply) => {
      const reason: CancelAppointmentRequest['reason'] = readCancelReason(request.body);
      const appointment = await appointmentService.cancelAppointmentByRequester(
        request.server.db,
        requireUser(request),
        request.params.id,
        reason,
      );
      return reply.status(200).send(toAppointment(appointment));
    },
  );

  done();
};
