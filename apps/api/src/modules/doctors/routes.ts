import {
  availabilityQuerySchema,
  availabilityResponseSchema,
  createDoctorRequestSchema,
  createLeaveRequestSchema,
  doctorSchema,
  leaveSchema,
  listDoctorsQuerySchema,
  listDoctorsResponseSchema,
  updateDoctorRequestSchema,
  workingHourInputSchema,
  workingHourSchema,
  type AvailabilityResponse,
  type Doctor,
  type DoctorSummary,
  type Leave,
  type ListDoctorsResponse,
  type WorkingHour,
} from '@health/contracts';
import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { requireAuth, requireRole, requireUser } from '../auth/guards.js';

import type { AvailabilitySlot } from './availability.js';
import type { DoctorRow, LeaveRow, WorkingHourRow } from './repository.js';
import * as doctorService from './service.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const workingHourIdParamsSchema = z.object({
  id: z.string().uuid(),
  workingHourId: z.string().uuid(),
});
const leaveIdParamsSchema = z.object({ id: z.string().uuid(), leaveId: z.string().uuid() });

function toDoctorSummary(row: DoctorRow): DoctorSummary {
  return {
    id: row.id,
    fullName: row.fullName,
    specialization: row.specialization,
    bio: row.bio,
    slotDurationMins: row.slotDurationMins,
    consultationFee: row.consultationFee,
    isActive: row.isActive,
  };
}

function toWorkingHour(row: WorkingHourRow): WorkingHour {
  return { id: row.id, dayOfWeek: row.dayOfWeek, startTime: row.startTime, endTime: row.endTime };
}

function toDoctor(doctor: DoctorRow, workingHours: WorkingHourRow[]): Doctor {
  return { ...toDoctorSummary(doctor), workingHours: workingHours.map(toWorkingHour) };
}

function toLeave(row: LeaveRow): Leave {
  return { id: row.id, leaveDate: row.leaveDate, reason: row.reason };
}

function toSlot(slot: AvailabilitySlot): { start: string; end: string } {
  return { start: slot.start.toISOString(), end: slot.end.toISOString() };
}

/**
 * Everything here is admin-only, enforced once at the top rather than on every individual route —
 * a route added later without thinking about it inherits the guard instead of accidentally skipping
 * it.
 */
export const adminDoctorRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.addHook('preHandler', requireRole('admin'));

  app.post(
    '/',
    { schema: { body: createDoctorRequestSchema, response: { 201: doctorSchema } } },
    async (request, reply) => {
      const created = await doctorService.createDoctor(
        request.server.db,
        request.body,
        requireUser(request).id,
      );
      return reply.status(201).send(toDoctor(created.doctor, created.workingHours));
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        params: idParamSchema,
        body: updateDoctorRequestSchema,
        response: { 200: doctorSchema },
      },
    },
    async (request, reply) => {
      const updated = await doctorService.updateDoctor(
        request.server.db,
        request.params.id,
        request.body,
      );
      const workingHours = await doctorService.listWorkingHours(
        request.server.db,
        request.params.id,
      );
      return reply.status(200).send(toDoctor(updated, workingHours));
    },
  );

  app.post(
    '/:id/working-hours',
    {
      schema: {
        params: idParamSchema,
        body: workingHourInputSchema,
        response: { 201: workingHourSchema },
      },
    },
    async (request, reply) => {
      const created = await doctorService.addWorkingHour(
        request.server.db,
        request.params.id,
        request.body,
      );
      return reply.status(201).send(toWorkingHour(created));
    },
  );

  app.delete(
    '/:id/working-hours/:workingHourId',
    { schema: { params: workingHourIdParamsSchema } },
    async (request, reply) => {
      await doctorService.deleteWorkingHour(
        request.server.db,
        request.params.id,
        request.params.workingHourId,
      );
      return reply.status(204).send();
    },
  );

  app.get(
    '/:id/leaves',
    { schema: { params: idParamSchema, response: { 200: z.array(leaveSchema) } } },
    async (request, reply) => {
      const leaves = await doctorService.listLeaves(request.server.db, request.params.id);
      return reply.status(200).send(leaves.map(toLeave));
    },
  );

  app.post(
    '/:id/leaves',
    {
      schema: {
        params: idParamSchema,
        body: createLeaveRequestSchema,
        response: { 201: leaveSchema },
      },
    },
    async (request, reply) => {
      const created = await doctorService.addLeave(
        request.server.db,
        request.params.id,
        request.body,
        requireUser(request).id,
      );
      return reply.status(201).send(toLeave(created));
    },
  );

  app.delete(
    '/:id/leaves/:leaveId',
    { schema: { params: leaveIdParamsSchema } },
    async (request, reply) => {
      await doctorService.deleteLeave(request.server.db, request.params.id, request.params.leaveId);
      return reply.status(204).send();
    },
  );

  done();
};

/**
 * Any signed-in user — patient, doctor, or admin — can browse the directory and check availability.
 * Nothing here is a secret; it is what a patient needs to see before they can book.
 */
export const publicDoctorRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.addHook('preHandler', requireAuth);

  app.get(
    '/',
    {
      schema: { querystring: listDoctorsQuerySchema, response: { 200: listDoctorsResponseSchema } },
    },
    async (request, reply): Promise<ListDoctorsResponse> => {
      const result = await doctorService.listDoctors(request.server.db, request.query);
      return reply.status(200).send({
        items: result.items.map(toDoctorSummary),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
      });
    },
  );

  app.get(
    '/:id',
    { schema: { params: idParamSchema, response: { 200: doctorSchema } } },
    async (request, reply) => {
      const { doctor, workingHours } = await doctorService.getDoctor(
        request.server.db,
        request.params.id,
      );
      return reply.status(200).send(toDoctor(doctor, workingHours));
    },
  );

  app.get(
    '/:id/availability',
    {
      schema: {
        params: idParamSchema,
        querystring: availabilityQuerySchema,
        response: { 200: availabilityResponseSchema },
      },
    },
    async (request, reply): Promise<AvailabilityResponse> => {
      const { slots } = await doctorService.getAvailability(
        request.server.db,
        request.params.id,
        request.query,
      );
      return reply.status(200).send({
        doctorId: request.params.id,
        from: request.query.from,
        to: request.query.to,
        slots: slots.map(toSlot),
      });
    },
  );

  done();
};
