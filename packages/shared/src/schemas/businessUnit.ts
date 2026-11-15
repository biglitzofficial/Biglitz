import { z } from "zod";

export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm");

export const salesCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["amount", "count"]),
  active: z.boolean(),
  order: z.number().int().nonnegative(),
});
export type SalesCategory = z.infer<typeof salesCategorySchema>;

export const businessCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{2,6}$/, "Code must be 2-6 uppercase letters or digits");

export const businessUnitSchema = z.object({
  name: z.string().min(1),
  code: businessCodeSchema,
  active: z.boolean(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radiusMeters: z.number().int().min(100).max(200),
    })
    .nullable(),
  defaultShift: z.object({ start: timeOfDaySchema, end: timeOfDaySchema }),
  salesCategories: z.array(salesCategorySchema),
  holidays: z.array(z.object({ date: z.string(), name: z.string() })),
  idCounter: z.number().int().nonnegative(),
  admins: z.array(z.string()),
});
export type BusinessUnit = z.infer<typeof businessUnitSchema>;
