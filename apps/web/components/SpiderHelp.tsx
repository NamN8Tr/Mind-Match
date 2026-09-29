import type { SpiderMode } from "@smart-rot/shared-types";

function suitCountLabel(mode: SpiderMode): string {
  return mode === "1-suit" ? "One suit" : `${mode[0]} suits`;
}

/**
 * The one copy of Spider's rules, shared by the in-match Help dialog and the
 * lobby's How to play dialog. The lobby opens it before a suit count or a play
 * kind has been picked, so both narrow the closing section rather than gate it.
 */
export function SpiderHelpSections({
  mode,
  kind,
}: {
  mode?: SpiderMode;
  kind?: "ranked" | "solo";
}) {
  return (
    <>
      <section>
        <h3>The goal</h3>
        <p>
          Build a run from King all the way down to Ace in a single suit. Finish one and it clears itself off the board.
          Clear eight and you win.
        </p>
      </section>
      <section>
        <h3>Moving cards</h3>
        <ul>
          <li><strong>Tap a card</strong> and it moves itself to the best spot — same suit first, then any suit, then an empty column.</li>
          <li><strong>Drag a card</strong> instead when you want to pick the spot yourself.</li>
          <li>A card sits on the next rank up, so a 7 goes on an 8. Empty columns accept anything.</li>
          <li>Cards already in a same-suit run travel together as one stack.</li>
        </ul>
      </section>
      <section>
        <h3>When you get stuck</h3>
        <ul>
          <li><strong>Out of moves?</strong> Click the stock pile above the board to deal one card to every column, even empty ones.</li>
          <li><strong>Not sure what to play?</strong> Hint points out a move that flips a card or builds a run.</li>
          <li><strong>Changed your mind?</strong> Take back undoes your last move. Hints and take backs are both unlimited.</li>
        </ul>
      </section>
      <section className="game-help-wide">
        <h3>{mode ? "This mode" : "Picking a mode"}</h3>
        <p>
          {mode === undefined
            ? "One suit is the gentlest start: every descending stack moves as a group. Two, three, and four suits mix things up — you can still stack any card on the next rank up, but only a run in a single suit moves together."
            : mode === "1-suit"
              ? "Every card here is the same suit, so any descending stack moves as a group."
              : `${suitCountLabel(mode)} are in play. You can stack any card on the next rank up, but only a run in a single suit moves together.`}
          {" "}
          {kind === "solo"
            ? "Play at your own pace — a clear sets your personal best for this mode."
            : kind === "ranked"
              ? "You and your opponent get the same board, and the fastest clear wins. Leaving on its own is not a loss; if you both leave, the race is a draw."
              : "Solo runs are timed against your own personal best. Ranked puts you and an opponent on the very same board, where the fastest clear wins."}
        </p>
        <p className="game-help-footnote">Every deal is guaranteed solvable, so there is always a way through.</p>
      </section>
    </>
  );
}
