import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AccountMenu } from "../components/AccountMenu";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Rot",
  description: "Ranked head-to-head puzzle games",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      appearance={{
        options: {
          unsafe_disableDevelopmentModeWarnings: process.env.NODE_ENV === "development",
        },
      }}
    >
      <html lang="en">
        <body>
          <header className="site-header">
            <Link className="brand" href="/">
              Smart Rot
            </Link>
            <div className="header-actions">
              <div className="signed-in-actions">
                <AccountMenu />
              </div>
            </div>
          </header>
          <main className="site-main">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
