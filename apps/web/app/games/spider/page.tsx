import { Show } from "@clerk/nextjs";
import { SpiderLobby } from "../../../components/SpiderLobby";

export default function SpiderPage() {
  return (
    <Show
      when="signed-in"
      fallback={
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Spider</h2>
          <p className="muted">Sign in to race a guaranteed-solvable board or play a timed solo run.</p>
        </div>
      }
    >
      <SpiderLobby />
    </Show>
  );
}
