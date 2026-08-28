"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { getMe, type MeResponse, updateUsername } from "../lib/api";

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

  const speedBest = profile?.personalBests.find((best) => best.gameId === "wordle" && best.mode === "speed");

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

      <section className="card profile-section">
        <div className="profile-section-heading">
          <div>
            <h2>Personal bests</h2>
            <p className="muted">Fastest completed solo runs in timed modes.</p>
          </div>
          <Link className="btn-secondary" href="/games/wordle">
            Play Wordle
          </Link>
        </div>
        <div className="personal-best-row">
          <div>
            <strong>Wordle Speed Solo</strong>
            <span className="muted">Server timed</span>
          </div>
          <span className="personal-best-time">{speedBest ? formatTime(speedBest.bestTimeMs) : "No time yet"}</span>
        </div>
      </section>
    </div>
  );
}
