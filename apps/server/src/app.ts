import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthDecorators } from "./auth/fastify-plugin.js";
import { env } from "./env.js";
import { registerApiRoutes } from "./routes/api.js";

/**
 * Builds the REST API without binding a port, so tests can drive it through
 * Fastify's `inject()` and the entrypoint can own listening separately.
 */
export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cors, {
    origin: env.webOrigin,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  registerAuthDecorators(app);
  await registerApiRoutes(app);

  return app;
}
