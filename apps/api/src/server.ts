import { buildApp } from "./app.js";
import { buildContext } from "./bootstrap.js";

const ctx = buildContext();
const app = buildApp(ctx);

app.listen({ port: ctx.env.PORT, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
