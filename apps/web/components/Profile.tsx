"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { getMe, type MeResponse, updateUsername } from "../lib/api";

const ACHIEVEMENT_MODES = [
  { gameId: "wordle", mode: "speed", gameLabel: "Wordle", modeLabel: "Speed", timed: true },
  { gameId: "wordle", mode: "fewest-guesses", gameLabel: "Wordle", modeLabel: "Fewest Guesses", timed: false },
  { gameId: "spider", mode: "1-suit", gameLabel: "Spider", modeLabel: "1 Suit", timed: true },
  { gameId: "spider", mode: "2-suit", gameLabel: "Spider", modeLabel: "2 Suits", timed: true },
  { gameId: "spider", mode: "3-suit", gameLabel: "Spider", modeLabel: "3 Suits", timed: true },
  { gameId: "spider", mode: "4-suit", gameLabel: "Spider", modeLabel: "4 Suits", timed: true },
] as const;

function formatTime(milliseconds: number): string {
  const totalTenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function Profile() {
  const { getToken } = useAuth();
  const [profile, setProfile] = useState<MeResponse | null>(null);
  const [username, setUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getMe(await getToken());
        if (cancelled) return;
        setProfile(data);
        setUsername(data.displayName);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load profile");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  async function saveUsername(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await updateUsername(await getToken(), username);
      setProfile((current) => (current ? { ...current, displayName: updated.displayName } : current));
      setUsername(updated.displayName);
      setMessage("Username updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update username");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack profile-stack">
      <Link className="back-link" href="/">
        ← Home
      </Link>
      <section className="profile-header">
        <span className="eyebrow">Your profile</span>
        <h1>{profile?.displayName ?? "Loading…"}</h1>
        <p className="muted">Your username appears to opponents and in match history.</p>
      </section>

      <section className="card profile-section">
        <h2>Username</h2>
        <form className="profile-form" onSubmit={saveUsername}>
          <label htmlFor="profile-username">Username</label>
          <div className="profile-form-row">
            <input
              id="profile-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={3}
              maxLength={20}
              pattern="[A-Za-z0-9_-]+"
              disabled={!profile || saving}
              required
            />
            <button className="btn" type="submit" disabled={!profile || saving || username === profile.displayName}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="muted profile-help">3–20 characters: letters, numbers, underscores, or hyphens.</p>
        </form>
        {message && <p className="success-text">{message}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="card profile-section" id="achievements">
        <div className="profile-section-heading">
          <div>
            <h2>Achievements</h2>
            <p className="muted">Ranked wins and fastest completed games.</p>
          </div>
          <Link className="btn-secondary" href="/">
            Choose a game
          </Link>
        </div>
        {ACHIEVEMENT_MODES.map((achievement) => {
          const best = profile?.personalBests.find(
            (entry) =>
              entry.gameId === achievement.gameId &&
              (entry.mode === achievement.mode ||
                (achievement.gameId === "spider" && achievement.mode === "1-suit" && entry.mode === "speed")),
          );
          const wins = profile?.rankedWins.find(
            (entry) => entry.gameId === achievement.gameId && entry.mode === achievement.mode,
          )?.wins ?? 0;
          return (
            <div className="personal-best-row" key={`${achievement.gameId}-${achievement.mode}`}>
              <div>
                <strong>{achievement.gameLabel} {achievement.modeLabel}</strong>
                <span className="muted">{achievement.timed ? "Solo or ranked best" : "Ranked mode"}</span>
              </div>
              <div className="achievement-stats">
                <span className="achievement-stat">
                  <small>Wins</small>
                  <strong>{wins}</strong>
                </span>
                {achievement.timed && (
                  <span className="achievement-stat">
                    <small>Best</small>
                    <strong>{best ? formatTime(best.bestTimeMs) : "—"}</strong>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
