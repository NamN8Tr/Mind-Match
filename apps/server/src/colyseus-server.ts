import { Server } from "@colyseus/core";
import { RedisDriver } from "@colyseus/redis-driver";
import { RedisPresence } from "@colyseus/redis-presence";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { wordleEngine } from "@smart-rot/game-engines";
import { env } from "./env.js";
import { createMatchmakingRoom } from "./matchmaking/matchmaking-room.js";
import { createGameRoom } from "./rooms/create-game-room.js";

/**
 * Wires up every game plugin's match room + matchmaking queue. Adding a new
 * game (Phase 2+) means one more `wordleEngine`-shaped import and two more
 * `.define()` calls here — matchmaking/rating/persistence code is unaffected.
 *
 * Runs on its own http.Server (see env.colyseusPort) rather than sharing
 * Fastify's — see the comment on env.colyseusPort for why.
 */
export function createColyseusServer(): Server {
  const gameServer = new Server({
    transport: new WebSocketTransport(),
    presence: new RedisPresence(env.redisUrl),
    driver: new RedisDriver(env.redisUrl),
  });

  gameServer.define("wordle", createGameRoom(wordleEngine));
  gameServer.define("wordle_matchmaking", createMatchmakingRoom("wordle", "wordle"));

  return gameServer;
}
