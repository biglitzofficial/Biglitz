import { z } from "zod";

/** Every API error returns this shape. */
export const apiErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;
