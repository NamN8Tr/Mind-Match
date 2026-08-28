import Link from "next/link";

export default function HomePage() {
  return (
    <div className="stack home-stack">
      <section className="home-hero">
        <span className="eyebrow">Ranked puzzle competition</span>
        <h1>Choose your puzzle</h1>
        <p className="muted">Every game has server-verified results, ranked matchmaking, and match history.</p>
      </section>

      <section aria-labelledby="available-games-heading">
        <h2 id="available-games-heading" className="section-title">
          Games
        </h2>
        <div className="game-grid">
          <Link className="game-card game-card-active" href="/games/wordle">
            <div className="game-card-icon" aria-hidden="true">
              <span>W</span>
            </div>
            <div>
              <div className="game-card-heading">
                <h3>Wordle</h3>
                <span className="availability-pill">Play now</span>
              </div>
              <p>Race an opponent for speed or win by solving in fewer guesses.</p>
            </div>
            <span className="game-card-arrow" aria-hidden="true">
              →
            </span>
          </Link>

          <Link className="game-card game-card-active game-card-spider" href="/games/spider">
            <div className="game-card-icon game-card-icon-spider" aria-hidden="true">
              <span>♠</span>
            </div>
            <div>
              <div className="game-card-heading">
                <h3>Spider Sprint</h3>
                <span className="availability-pill">Play now</span>
              </div>
              <p>Race on identical, guaranteed-solvable one-suit Spider boards or chase a solo best.</p>
            </div>
            <span className="game-card-arrow" aria-hidden="true">→</span>
          </Link>

          <article className="game-card game-card-disabled">
            <div className="game-card-icon game-card-icon-muted" aria-hidden="true">
              <span>9</span>
            </div>
            <div>
              <div className="game-card-heading">
                <h3>Sudoku</h3>
                <span className="coming-soon-pill">Coming soon</span>
              </div>
              <p>Competitive number grids on identical seeded puzzles.</p>
            </div>
          </article>

          <article className="game-card game-card-disabled">
            <div className="game-card-icon game-card-icon-muted" aria-hidden="true">
              <span>✦</span>
            </div>
            <div>
              <div className="game-card-heading">
                <h3>Minesweeper</h3>
                <span className="coming-soon-pill">Coming soon</span>
              </div>
              <p>Clear the same board with accuracy and speed.</p>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
