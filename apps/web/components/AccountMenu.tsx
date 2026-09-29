"use client";

import { SignInButton, UserButton, useAuth, useUser } from "@clerk/nextjs";
import {
  UserProfileAccountPanel,
  UserProfileConnectedAccountsSection,
  UserProfileDeleteSection,
  UserProfileEmailSection,
  UserProfileEnterpriseAccountsSection,
  UserProfilePasswordSection,
  UserProfilePhoneSection,
  UserProfileProfileSection,
  UserProfileProvider,
  UserProfileUsernameSection,
  UserProfileWeb3Section,
} from "@clerk/ui/experimental";
import { useEffect, useRef, useState } from "react";
import { deleteMe, getMe, type MeResponse, updateUsername } from "../lib/api";
import { formatTime } from "../lib/format";
import { ACHIEVEMENT_MODES, isSameMode } from "../lib/achievements";

type AccountView = "profile" | "achievements";

function ProfileIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M8 4h8v4a4 4 0 0 1-8 0V4Zm0 2H5v1a4 4 0 0 0 4 4m7-5h3v1a4 4 0 0 1-4 4m-3 1v4m-4 3h8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function formatGame(gameId: string): string {
  return gameId.charAt(0).toUpperCase() + gameId.slice(1);
}

function formatMode(mode: string): string {
  if (mode === "fewest-guesses") return "Fewest Guesses";
  if (mode === "speed") return "Speed";
  if (/^[1-4]-suit$/.test(mode)) return `${mode[0]} ${mode[0] === "1" ? "Suit" : "Suits"}`;
  return mode;
}

function ClerkProfile() {
  const { getToken } = useAuth();
  const { user } = useUser();
  const lastSyncedUsername = useRef<string | null>(null);

  useEffect(() => {
    const username = user?.username;
    if (!username || lastSyncedUsername.current === username) return;

    let cancelled = false;
    lastSyncedUsername.current = username;
    void (async () => {
      try {
        const token = await getToken();
        const profile = await getMe(token);
        if (!cancelled && profile.displayName !== username) {
          await updateUsername(token, username);
        }
      } catch {
        if (!cancelled) lastSyncedUsername.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getToken, user?.username]);

  return (
    <div className="account-clerk-profile">
      <UserProfileProvider>
        <UserProfileAccountPanel>
          <UserProfileProfileSection />
          <UserProfileUsernameSection />
          <UserProfileEmailSection />
          <UserProfilePhoneSection />
          <UserProfileConnectedAccountsSection />
          <UserProfileEnterpriseAccountsSection />
          <UserProfileWeb3Section />
          <UserProfilePasswordSection />
          <UserProfileDeleteSection />
        </UserProfileAccountPanel>
      </UserProfileProvider>
    </div>
  );
}

function AchievementsPanel() {
  const { getToken } = useAuth();
  const [profile, setProfile] = useState<MeResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getMe(await getToken());
        if (!cancelled) setProfile(data);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const additionalBests = profile?.personalBests.filter(
    (best) =>
      !ACHIEVEMENT_MODES.some(
        (achievement) => achievement.gameId === best.gameId && isSameMode(best.gameId, best.mode, achievement.mode),
      ),
  );

  return (
    <section className="account-personal-bests" aria-labelledby="achievements-title">
      <div className="account-achievements-heading">
        <h2 id="achievements-title">Achievements</h2>
        <p>Ranked wins and fastest completed games.</p>
      </div>
      {error && <p className="account-personal-bests-error">Could not load achievements.</p>}
      {!error && !profile && <p className="account-personal-bests-loading">Loading…</p>}
      {!error && profile && (
        <>
          {ACHIEVEMENT_MODES.map((achievement) => {
            const best = profile.personalBests.find(
              (entry) =>
                entry.gameId === achievement.gameId && isSameMode(entry.gameId, entry.mode, achievement.mode),
            );
            const wins = profile.rankedWins.find(
              (entry) => entry.gameId === achievement.gameId && entry.mode === achievement.mode,
            )?.wins ?? 0;
            return (
              <div className="account-personal-best-row" key={`${achievement.gameId}-${achievement.mode}`}>
                <div className="account-achievement-copy">
                  <strong>{achievement.gameLabel}</strong>
                  <span>
                    {achievement.modeLabel}
                    {achievement.timed ? " · Solo or ranked best" : " · Ranked"}
                  </span>
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
          {additionalBests?.map((best) => (
            <div className="account-personal-best-row" key={`${best.gameId}-${best.mode}`}>
              <div className="account-achievement-copy">
                <strong>{formatGame(best.gameId)}</strong>
                <span>{formatMode(best.mode)}</span>
              </div>
              <div className="achievement-stats">
                <span className="achievement-stat">
                  <small>Best</small>
                  <strong>{formatTime(best.bestTimeMs)}</strong>
                </span>
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function AccountDialog({
  initialView,
  onClose,
  onDeleteSubmit,
}: {
  initialView: AccountView;
  onClose: () => void;
  onDeleteSubmit: () => void;
}) {
  const [view, setView] = useState<AccountView>(initialView);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div className="account-dialog-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section aria-label="Manage account" aria-modal="true" className="account-dialog" role="dialog">
        <button aria-label="Close modal" autoFocus className="account-dialog-close" onClick={onClose} type="button">
          <span aria-hidden="true">×</span>
        </button>
        <aside className="account-dialog-sidebar">
          <strong>Account</strong>
          <nav aria-label="Account settings">
            <button
              aria-current={view === "profile" ? "page" : undefined}
              onClick={() => setView("profile")}
              type="button"
            >
              <ProfileIcon />
              Profile
            </button>
            <button
              aria-current={view === "achievements" ? "page" : undefined}
              onClick={() => setView("achievements")}
              type="button"
            >
              <TrophyIcon />
              Achievements
            </button>
          </nav>
        </aside>
        <div
          className="account-dialog-content"
          onSubmitCapture={(event) => {
            if ((event.target as HTMLFormElement).querySelector('[name="deleteConfirmation"]')) {
              onDeleteSubmit();
            }
          }}
        >
          {view === "profile" ? <ClerkProfile /> : <AchievementsPanel />}
        </div>
      </section>
    </div>
  );
}

export function AccountMenu() {
  const { getToken } = useAuth();
  const { isLoaded, isSignedIn } = useUser();
  const [dialogView, setDialogView] = useState<AccountView | null>(null);
  const deletionSubmitted = useRef(false);
  const deletionToken = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || isSignedIn || !deletionSubmitted.current || !deletionToken.current) return;
    const token = deletionToken.current;
    deletionSubmitted.current = false;
    deletionToken.current = null;
    void deleteMe(token).catch(() => undefined);
  }, [isLoaded, isSignedIn]);

  function openAccount() {
    deletionSubmitted.current = false;
    setDialogView("profile");
    void getToken().then((token) => {
      deletionToken.current = token;
    });
  }

  function closeAccount() {
    deletionSubmitted.current = false;
    deletionToken.current = null;
    setDialogView(null);
  }

  if (!isLoaded) return null;
  if (!isSignedIn) return <SignInButton mode="modal" />;

  return (
    <>
      <UserButton
        appearance={{
          elements: {
            userButtonPopoverActionButton__manageAccount: { display: "none" },
          },
        }}
        showName={false}
      >
        <UserButton.MenuItems>
          <UserButton.Action label="Manage account" labelIcon={<ProfileIcon />} onClick={openAccount} />
          <UserButton.Action label="signOut" />
        </UserButton.MenuItems>
      </UserButton>
      {dialogView && (
        <AccountDialog
          initialView={dialogView}
          onClose={closeAccount}
          onDeleteSubmit={() => {
            deletionSubmitted.current = true;
          }}
        />
      )}
    </>
  );
}
