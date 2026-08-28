import { Show } from "@clerk/nextjs";
import { Lobby } from "../../../components/Lobby";

export default function WordlePage() {
  return (
    <Show
      when="signed-in"
      fallback={
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Wordle</h2>
          <p className="muted">Sign in to choose a mode and find a ranked opponent.</p>
        </div>
      }
    >
      <Lobby />
    </Show>
  );
}
