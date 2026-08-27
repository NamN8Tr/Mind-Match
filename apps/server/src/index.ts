import "dotenv/config";
import Fastify from "fastify";
import { registerAuthDecorators } from "./auth/fastify-plugin.js";
import { createColyseusServer } from "./colyseus-server.js";
import { env } from "./env.js";
import { registerApiRoutes } from "./routes/api.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  registerAuthDecorators(app);
  await registerApiRoutes(app);

  await app.listen({ port: env.port, host: "0.0.0.0" });

  const colyseus = createColyseusServer();
  await colyseus.listen(env.colyseusPort);

  app.log.info(`REST API listening on :${env.port}, Colyseus WS listening on :${env.colyseusPort}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
