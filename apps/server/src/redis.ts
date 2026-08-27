import { Redis } from "ioredis";
import { env } from "./env.js";

/**
 * A plain ioredis client for our own ephemeral state (session locks, and
 * anything else that isn't a Colyseus room's internal presence/driver
 * wiring — those get their own separate connections via RedisPresence /
 * RedisDriver in colyseus-server.ts).
 */
export const redis = new Redis(env.redisUrl);
