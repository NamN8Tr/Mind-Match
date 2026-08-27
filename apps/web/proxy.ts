import { clerkMiddleware } from "@clerk/nextjs/server";

// clerkMiddleware() itself is required — it's what populates auth() / <Show>
// for every request, not just a route-protection hook. We don't do
// path-matcher-based protection here (createRouteMatcher is deprecated in
// this Clerk version in favor of per-page/route checks): "/" already
// degrades gracefully for signed-out users via <Show>, and the actual
// authorization boundary is apps/server independently verifying the Clerk
// token on every REST/Colyseus call — this app never server-renders
// protected data itself.
export default clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
