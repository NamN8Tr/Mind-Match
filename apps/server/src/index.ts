import "dotenv/config";
import { buildApp } from "./app.js";
import { createColyseusServer } from "./colyseus-server.js";
import { env } from "./env.js";
import { abortStaleActiveMatches } from "./matchmaking/match-service.js";

async function main(): Promise<void> {
  const app = await buildApp();

  // Any match still ACTIVE at boot belonged to a previous process — its
  // in-memory room is gone, so it can never complete normally.
  await abortStaleActiveMatches();

  await app.listen({ port: env.port, host: "0.0.0.0" });

  const colyseus = createColyseusServer();
  await colyseus.listen(env.colyseusPort);

  app.log.info(`REST API listening on :${env.port}, Colyseus WS listening on :${env.colyseusPort}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
