import { Show } from "@clerk/nextjs";
import { PublicPlayerProfile } from "../../../components/PublicPlayerProfile";

export default async function PlayerProfilePage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return (
    <Show
      when="signed-in"
      fallback={
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Player profile</h2>
          <p className="muted">Sign in to view player profiles.</p>
        </div>
      }
    >
      <PublicPlayerProfile userId={userId} />
    </Show>
  );
}
