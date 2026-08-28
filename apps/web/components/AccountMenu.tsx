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

type AccountView = "profile" | "personal-bests";

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

function formatTime(milliseconds: number): string {
  const totalTenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
}

function formatGame(gameId: string): string {
  return gameId.charAt(0).toUpperCase() + gameId.slice(1);
}

function formatMode(mode: string): string {
  if (mode === "fewest-guesses") return "Fewest Guesses";
  if (mode === "speed") return "Speed · Solo";
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

function PersonalBestsPanel() {
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

  const speedSoloBest = profile?.personalBests.find((best) => best.gameId === "wordle" && best.mode === "speed");
  const additionalBests = profile?.personalBests.filter(
    (best) => best.gameId !== "wordle" || best.mode !== "speed",
  );

  return (
    <section className="account-personal-bests" aria-labelledby="personal-bests-title">
      <h2 id="personal-bests-title">Personal Bests</h2>
      {error && <p className="account-personal-bests-error">Could not load personal bests.</p>}
      {!error && !profile && <p className="account-personal-bests-loading">Loading…</p>}
      {!error && profile && (
        <>
          <div className="account-personal-best-row">
            <div>
              <strong>Wordle</strong>
              <span>Speed · Solo</span>
            </div>
            <span className="account-personal-best-time">
              {speedSoloBest ? formatTime(speedSoloBest.bestTimeMs) : "—"}
            </span>
          </div>
          {additionalBests?.map((best) => (
            <div className="account-personal-best-row" key={`${best.gameId}-${best.mode}`}>
              <div>
                <strong>{formatGame(best.gameId)}</strong>
                <span>{formatMode(best.mode)}</span>
              </div>
              <span className="account-personal-best-time">{formatTime(best.bestTimeMs)}</span>
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
              aria-current={view === "personal-bests" ? "page" : undefined}
              onClick={() => setView("personal-bests")}
              type="button"
            >
              <TrophyIcon />
              Personal Bests
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
          {view === "profile" ? <ClerkProfile /> : <PersonalBestsPanel />}
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
