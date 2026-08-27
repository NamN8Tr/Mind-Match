function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env["PORT"] ?? 4000),
  // Colyseus's Server installs its own HTTP request handling on whatever
  // http.Server its transport is bound to (colyseus/core's bindRouterToTransport
  // runs unconditionally, not just when an `express` app is configured). Sharing
  // Fastify's server with it causes both to write a response to the same
  // request and crash the process (ERR_HTTP_HEADERS_SENT) the moment a request
  // hits a route only one of them recognizes. Giving Colyseus its own port
  // sidesteps that entirely — a common split for REST API vs. realtime gateway.
  colyseusPort: Number(process.env["COLYSEUS_PORT"] ?? 4001),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  clerkSecretKey: required("CLERK_SECRET_KEY"),
  clerkPublishableKey: required("CLERK_PUBLISHABLE_KEY"),
};
