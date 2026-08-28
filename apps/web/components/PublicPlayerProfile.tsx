"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getPlayerProfile, type PublicPlayerProfile as PublicPlayerProfileData } from "../lib/api";

interface PublicPlayerProfileProps {
  userId: string;
}

function formatTime(milliseconds: number): string {
  const totalTenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
}

function formatMode(mode: string): string {
  if (mode === "fewest-guesses") return "Fewest Guesses";
  if (mode === "speed") return "Speed";
  return mode;
}

function formatGame(gameId: string): string {
  return gameId.charAt(0).toUpperCase() + gameId.slice(1);
}

export function PublicPlayerProfile({ userId }: PublicPlayerProfileProps) {
  const { getToken } = useAuth();
  const [profile, setProfile] = useState<PublicPlayerProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getPlayerProfile(await getToken(), userId);
        if (!cancelled) setProfile(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load player profile");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, userId]);

  if (error) {
    return (
      <div className="stack profile-stack">
        <Link className="back-link" href="/games/wordle">
          ← Wordle
        </Link>
        <div className="card">
          <h1 className="public-profile-error-title">Player unavailable</h1>
          <p className="error-text">{error}</p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="card">
        <p className="muted">
          Loading player profile <span className="spinner-dot" />
        </p>
      </div>
    );
  }

  const wordleRatings = profile.ratings.filter((rating) => rating.gameId === "wordle");

  return (
    <div className="stack profile-stack">
      <Link className="back-link" href="/games/wordle">
        ← Wordle
      </Link>

      <section className="profile-header">
        <span className="eyebrow">Player profile</span>
        <div className="public-profile-name-row">
          <h1>{profile.displayName}</h1>
          {profile.isBot && <span className="pill">Bot</span>}
        </div>
        <p className="muted">
          Playing since {new Date(profile.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </p>
      </section>

      <section className="profile-stat-grid" aria-label="Ranked record">
        <div className="profile-stat-card">
          <strong>{profile.stats.rankedMatches}</strong>
          <span>Matches</span>
        </div>
        <div className="profile-stat-card profile-stat-win">
          <strong>{profile.stats.wins}</strong>
          <span>Wins</span>
        </div>
        <div className="profile-stat-card">
          <strong>{profile.stats.draws}</strong>
          <span>Draws</span>
        </div>
        <div className="profile-stat-card profile-stat-loss">
          <strong>{profile.stats.losses}</strong>
          <span>Losses</span>
        </div>
      </section>

      <section className="card profile-section">
        <h2>Wordle ratings</h2>
        <div className="public-rating-grid">
          {["speed", "fewest-guesses"].map((mode) => {
            const rating = wordleRatings.find((entry) => entry.mode === mode);
            return (
              <div className="public-rating-card" key={mode}>
                <span>{formatMode(mode)}</span>
                <strong>{rating ? Math.round(rating.rating) : "Unrated"}</strong>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card profile-section">
        <h2>Personal bests</h2>
        {profile.personalBests.length === 0 && <p className="muted">No timed personal bests yet.</p>}
        {profile.personalBests.map((best) => (
          <div className="personal-best-row" key={`${best.gameId}-${best.mode}`}>
            <div>
              <strong>
                {formatGame(best.gameId)} {formatMode(best.mode)} Solo
              </strong>
              <span className="muted">Server timed</span>
            </div>
            <span className="personal-best-time">{formatTime(best.bestTimeMs)}</span>
          </div>
        ))}
      </section>

      <section className="card profile-section">
        <div className="history-heading">
          <h2>Recent ranked matches</h2>
          <p className="muted">Latest completed matches</p>
        </div>
        {profile.matches.length === 0 && <p className="muted">No completed ranked matches yet.</p>}
        {profile.matches.map((entry) => {
          const opponent = entry.players.find((player) => player.userId !== profile.id);
          const player = entry.players.find((candidate) => candidate.userId === profile.id);
          const isDraw = entry.resultStatus === "draw";
          const outcomeClass = isDraw ? "pill-draw" : player?.isWinner ? "pill-win" : "pill-loss";
          const outcomeLabel = isDraw ? "Draw" : player?.isWinner ? "Win" : "Loss";
          const delta = entry.ratingAfter === null ? null : Math.round(entry.ratingAfter - entry.ratingBefore);
          return (
            <div className="history-row" key={entry.matchId}>
              <span className="history-opponent">
                {opponent ? (
                  <Link className="player-profile-link" href={`/players/${encodeURIComponent(opponent.userId)}`}>
                    vs {opponent.displayName}
                  </Link>
                ) : (
                  <span>vs unknown</span>
                )}
                <span className="history-mode">
                  {formatGame(entry.gameId)} · {formatMode(entry.mode)}
                </span>
              </span>
              <span className="row public-history-result">
                <span className={`pill ${outcomeClass}`}>{outcomeLabel}</span>
                {delta !== null && <span className="muted">{delta >= 0 ? `+${delta}` : delta}</span>}
              </span>
            </div>
          );
        })}
      </section>
    </div>
  );
}
