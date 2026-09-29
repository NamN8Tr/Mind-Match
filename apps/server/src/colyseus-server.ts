import { LocalDriver, LocalPresence, Server } from "@colyseus/core";
import { RedisDriver } from "@colyseus/redis-driver";
import { RedisPresence } from "@colyseus/redis-presence";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  spiderFourSuitEngine,
  spiderOneSuitEngine,
  spiderThreeSuitEngine,
  spiderTwoSuitEngine,
  wordleFewestGuessesEngine,
  wordleSpeedEngine,
} from "@smart-rot/game-engines";
import { env } from "./env.js";
import { createMatchmakingRoom } from "./matchmaking/matchmaking-room.js";
import { createGameRoom, type GameRoomOptions } from "./rooms/create-game-room.js";
import { createWordleSoloRoom, type WordleSoloRoomOptions } from "./rooms/wordle-solo-room.js";
import { createSpiderSoloRoom } from "./rooms/spider-solo-room.js";
import type { SpiderBoardPool } from "./spider-board-pool/service.js";

/**
 * Wires up every game plugin's match room + matchmaking queue (+ solo room for
 * timed modes). Adding a game or mode means one engine per mode and its
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
  /** Persistent random Spider inventory. Omitted by isolated integration tests. */
  spiderBoardPool?: SpiderBoardPool;
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
  const spiderVariants = [
    { key: "1_suit", mode: "1-suit", engine: spiderOneSuitEngine },
    { key: "2_suit", mode: "2-suit", engine: spiderTwoSuitEngine },
    { key: "3_suit", mode: "3-suit", engine: spiderThreeSuitEngine },
    { key: "4_suit", mode: "4-suit", engine: spiderFourSuitEngine },
  ] as const;
  for (const variant of spiderVariants) {
    const matchRoomName = `spider_${variant.key}`;
    gameServer.define(
      matchRoomName,
      createGameRoom(variant.engine, {
        ...options.gameRoom,
        idleTimeoutMs: options.gameRoom?.idleTimeoutMs ?? 10 * 60_000,
        departurePolicy: "continue-until-both-leave",
        timedPersonalBestMode: variant.mode,
        prepareSeed: options.spiderBoardPool
          ? async (seed) => { await options.spiderBoardPool!.prepareSeed(seed, variant.mode); }
          : undefined,
      }),
    );
    gameServer.define(`${matchRoomName}_matchmaking`, createMatchmakingRoom("spider", variant.mode, matchRoomName));
    gameServer.define(`${matchRoomName}_solo`, createSpiderSoloRoom(variant.engine, {
      ...options.soloRoom,
      prepareSeed: options.spiderBoardPool
        ? async (seed) => { await options.spiderBoardPool!.prepareSeed(seed, variant.mode); }
        : undefined,
    }));
  }

  return gameServer;
}
