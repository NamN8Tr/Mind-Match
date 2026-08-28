import { Show } from "@clerk/nextjs";
import { Profile } from "../../components/Profile";

export default function ProfilePage() {
  return (
    <Show
      when="signed-in"
      fallback={
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Profile</h2>
          <p className="muted">Sign in to edit your username and view personal bests.</p>
        </div>
      }
    >
      <Profile />
    </Show>
  );
}
