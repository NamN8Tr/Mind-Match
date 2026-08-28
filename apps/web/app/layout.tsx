import { ClerkProvider, Show, SignInButton, UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Rot",
  description: "Ranked head-to-head puzzle games",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <header className="site-header">
            <Link className="brand" href="/">
              Smart Rot
            </Link>
            <div className="header-actions">
              <Show when="signed-in" fallback={<SignInButton mode="modal" />}>
                <div className="signed-in-actions">
                  <Link className="profile-link" href="/profile">
                    Profile
                  </Link>
                  <UserButton />
                </div>
              </Show>
            </div>
          </header>
          <main className="site-main">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
