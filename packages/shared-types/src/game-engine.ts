export type PlayerId = string;

/**
 * Stable identifier for a game type. Extend this union as new game plugins
 * (Sudoku, Minesweeper, Spider Solitaire, ...) come online in later phases.
 */
export type GameId = "wordle";

export type MatchOutcomeStatus = "win" | "draw" | "aborted";

export interface MatchResult {
  status: MatchOutcomeStatus;
  /** Present only when status === "win". */
  winnerId?: PlayerId;
  /** Optional per-player raw score, useful for match history / tie-break display. */
  scores?: Record<PlayerId, number>;
  /** Short machine-readable reason, e.g. "solved", "timeout", "resigned". */
  reason: string;
}

export interface MoveOutcome<State> {
  state: State;
}

/**
 * Thrown by a GameEngine's applyMove/validateMove when a submitted move breaks
 * the game's rules. The match-orchestration layer catches this and rejects the
 * move without mutating server state, rather than trusting the client.
 */
export class GameRuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameRuleViolation";
  }
}

/**
 * The shared contract every game plugin implements. Matchmaking, lobby, rating,
 * and match-orchestration code depend only on this interface and never on a
 * specific game's rules, so new games can be added without touching those layers.
 *
 * State must be fully server-authoritative and JSON-serializable (it is synced to
 * clients via Colyseus room state and persisted to Postgres as match history).
 */
export interface GameEngine<State, Move> {
  readonly gameId: GameId;

  /**
   * Builds the starting state for a match. `seed` must deterministically produce
   * the same board/puzzle for all players in the match (see shared-seed principle
   * in the project README) so ranked results measure skill, not who got the easier board.
   */
  generateInitialState(seed: string, playerIds: PlayerId[]): State;

  /**
   * Throws GameRuleViolation if the move is illegal in the current state for this
   * player. Called before applyMove by the match orchestrator; engines may also
   * re-check inside applyMove defensively.
   */
  validateMove(state: State, move: Move, playerId: PlayerId): void;

  /** Applies an already-validated move and returns the resulting state. */
  applyMove(state: State, move: Move, playerId: PlayerId): MoveOutcome<State>;

  isTerminal(state: State): boolean;

  /** Only meaningful once isTerminal(state) is true. */
  getResult(state: State): MatchResult;

  /**
   * Optional game-specific result when the room's authoritative wall-clock
   * deadline expires before `isTerminal()` becomes true. Games that omit this
   * use a draw/timeout. This lets modes such as fewest-guesses award a player
   * who solved before the deadline while their opponent did not.
   */
  getTimeoutResult?(state: State): MatchResult;

  /**
   * Produces the view of state sent to a specific player, e.g. hiding an
   * opponent's in-progress guesses. `matchResult` is present when orchestration
   * ended the match outside the engine's own terminal rules (for example a
   * wall-clock timeout or disconnect forfeit), allowing the final view to
   * reveal information that must stay hidden during play.
   */
  serializeStateForPlayer(state: State, playerId: PlayerId, matchResult?: MatchResult): unknown;
}
