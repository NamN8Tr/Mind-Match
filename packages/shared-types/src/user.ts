export interface UserProfile {
  id: string;
  /** Clerk user id (external auth subject). Null for bot accounts. */
  authSubject: string | null;
  displayName: string;
  isBot: boolean;
  createdAt: string;
}

export interface TimedPersonalBest {
  gameId: string;
  mode: string;
  bestTimeMs: number;
  achievedAt: string;
}

export interface MatchOpponentInfo {
  userId: string;
  displayName: string;
  rating: number;
}

export interface SoloResultMessage {
  solved: boolean;
  elapsedMs: number | null;
  bestTimeMs: number | null;
  isPersonalBest: boolean;
  persisted: boolean;
}
