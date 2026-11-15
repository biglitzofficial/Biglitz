import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  /** Allowed browser origin for CORS, e.g. https://team.biglitz.in */
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_STORAGE_BUCKET: z.string().optional(),
  /** Full service-account JSON as a string (Railway). Omit when using the emulator. */
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  INTAKE_SECRET: z.string().optional(),
  N8N_WEBHOOK_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data;
}
