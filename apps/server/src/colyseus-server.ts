import { LocalDriver, LocalPresence, Server } from "@colyseus/core";
import { RedisDriver } from "@colyseus/redis-driver";
import { RedisPresence } from "@colyseus/redis-presence";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { wordleFewestGuessesEngine, wordleSpeedEngine } from "@smart-rot/game-engines";
import { env } from "./env.js";
import { createMatchmakingRoom } from "./matchmaking/matchmaking-room.js";
import { createGameRoom, type GameRoomOptions } from "./rooms/create-game-room.js";
import { createWordleSoloRoom, type WordleSoloRoomOptions } from "./rooms/wordle-solo-room.js";

/**
 * Wires up every game plugin's match room + matchmaking queue. Adding a new
 * game (Phase 2+) means one more `wordleEngine`-shaped import and two more
 * `.define()` calls here — matchmaking/rating/persistence code is unaffected.
 *
 * Runs on its own http.Server (see env.colyseusPort) rather than sharing
 * Fastify's — see the comment on env.colyseusPort for why.
 */
export interface ColyseusServerOptions {
  /**
   * Keep room discovery inside this process. Integration tests need this so a
   * concurrently running dev gateway in the same Redis instance cannot claim a
   * test room and hand back a seat reservation for a different endpoint.
   */
  isolated?: boolean;
  /** Optional lifecycle timings for integration tests; production uses the room defaults. */
  gameRoom?: GameRoomOptions;
  /** Optional solo timings/seed seam for integration tests. */
  soloRoom?: WordleSoloRoomOptions;
}

export function createColyseusServer(options: ColyseusServerOptions = {}): Server {
  const coordination = options.isolated
    ? { presence: new LocalPresence(), driver: new LocalDriver() }
    : { presence: new RedisPresence(env.redisUrl), driver: new RedisDriver(env.redisUrl) };
  const gameServer = new Server({
    transport: new WebSocketTransport(),
    ...coordination,
  });

  gameServer.define("wordle_speed", createGameRoom(wordleSpeedEngine, options.gameRoom));
  gameServer.define("wordle_speed_matchmaking", createMatchmakingRoom("wordle", "speed", "wordle_speed"));
  gameServer.define("wordle_fewest", createGameRoom(wordleFewestGuessesEngine, options.gameRoom));
  gameServer.define("wordle_fewest_matchmaking", createMatchmakingRoom("wordle", "fewest-guesses", "wordle_fewest"));
  gameServer.define("wordle_speed_solo", createWordleSoloRoom(options.soloRoom));

  return gameServer;
}
