import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ApiError } from "@biglitz/shared";
import type { AppContext } from "./context.js";
import { HttpError } from "./http.js";
import { guard } from "./routes/guard.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerUnitRoutes, getUnit } from "./routes/units.js";
import { registerEmployeeRoutes } from "./routes/employees.js";
import { registerAttendanceRoutes } from "./routes/attendance.js";
import { registerSalesRoutes } from "./routes/sales.js";
import { registerLeaveRoutes } from "./routes/leave.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerPayrollRoutes } from "./routes/payroll.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerReportRoutes } from "./routes/reports.js";

export { HttpError };

export function buildApp(ctx: AppContext): FastifyInstance {
  const env = ctx.env;
  const app = Fastify({ logger: env.NODE_ENV !== "test" });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", env.WEB_ORIGIN);
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("Vary", "Origin");
    if (req.method === "OPTIONS") return reply.code(204).send();
    return undefined;
  });

  // Every error is { code, message } with a human message.
  app.setErrorHandler((err, _req, reply) => {
    let status = 500;
    let body: ApiError = { code: "INTERNAL", message: "Something went wrong. Please try again." };
    if (err instanceof HttpError) {
      status = err.statusCode;
      body = { code: err.code, message: err.message };
    } else if (err instanceof ZodError) {
      status = 400;
      body = { code: "VALIDATION", message: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    } else {
      app.log.error(err);
    }
    return reply.code(status).send(body);
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", message: "That endpoint does not exist." } satisfies ApiError),
  );

  app.get("/health", async () => ({ ok: true, time: ctx.clock().toISOString() }));

  app.get("/api/me", { preHandler: guard(ctx, { allowMustChangePin: true }) }, async (req) => {
    const emp = req.actor.emp;
    const pin = (await ctx.db.collection("authPins").doc(emp.employeeId).get()).data() as { mustChangePin: boolean } | undefined;
    const unit = await getUnit(ctx, emp.businessId);
    return {
      employee: emp,
      mustChangePin: pin?.mustChangePin ?? false,
      unit: { code: unit.code, name: unit.name, hasSales: unit.salesCategories.some((c) => c.active), location: unit.location },
    };
  });

  registerAuthRoutes(app, ctx);
  registerUnitRoutes(app, ctx);
  registerEmployeeRoutes(app, ctx);
  registerAttendanceRoutes(app, ctx);
  registerSalesRoutes(app, ctx);
  registerLeaveRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerLeadRoutes(app, ctx);
  registerPayrollRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerReportRoutes(app, ctx);

  return app;
}
