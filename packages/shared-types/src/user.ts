export interface UserProfile {
  id: string;
  /** Clerk user id (external auth subject). Null for bot accounts. */
  authSubject: string | null;
  displayName: string;
  isBot: boolean;
  createdAt: string;
}
