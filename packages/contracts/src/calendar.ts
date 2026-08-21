import { z } from 'zod';

export const googleConnectUrlResponseSchema = z.object({ url: z.string().url() });
export type GoogleConnectUrlResponse = z.infer<typeof googleConnectUrlResponseSchema>;

export const googleConnectionStatusSchema = z.object({ connected: z.boolean() });
export type GoogleConnectionStatus = z.infer<typeof googleConnectionStatusSchema>;

export const googleDisconnectResponseSchema = z.object({ disconnected: z.literal(true) });
