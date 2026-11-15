import type { FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { authenticate } from "./auth.js";

/** Fastify preHandler: authenticates and sets `req.actor`. */
export const guard = (ctx: AppContext, opts: { allowMustChangePin?: boolean } = {}) => async (req: FastifyRequest): Promise<void> => {
  req.actor = await authenticate(ctx, req, opts);
};
