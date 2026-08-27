import { Show } from "@clerk/nextjs";
import { Lobby } from "../components/Lobby";

export default function HomePage() {
  return (
    <Show
      when="signed-in"
      fallback={
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Welcome to Smart Rot</h2>
          <p className="muted">Sign in to find a ranked Wordle match.</p>
        </div>
      }
    >
      <Lobby />
    </Show>
  );
}
