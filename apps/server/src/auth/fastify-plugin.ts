import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveAuthenticatedUser, UnauthorizedError } from "./clerk.js";
import type { User } from "../generated/prisma/client.js";

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: User;
  }
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length);
}

/** Verifies the request's Clerk token and attaches the corresponding User row. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    request.currentUser = await resolveAuthenticatedUser(extractBearerToken(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      await reply.code(401).send({ error: error.message });
      return;
    }
    throw error;
  }
}

export function registerAuthDecorators(app: FastifyInstance): void {
  app.decorateRequest("currentUser", undefined);
}
