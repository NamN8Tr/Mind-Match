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
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="10" r="2.6" />
                <ellipse cx="12" cy="15.8" rx="3.2" ry="3.6" />
                <path d="M9.6 8.8 L6 6.8 L4 8.2" />
                <path d="M9.4 10 L5.2 9.6 L3 11.6" />
                <path d="M9.5 11.2 L5.4 12.4 L3.6 15" />
                <path d="M10 12.2 L6.6 15 L5.6 18" />
                <path d="M14.4 8.8 L18 6.8 L20 8.2" />
                <path d="M14.6 10 L18.8 9.6 L21 11.6" />
                <path d="M14.5 11.2 L18.6 12.4 L20.4 15" />
                <path d="M14 12.2 L17.4 15 L18.4 18" />
              </svg>
            </div>
            <div>
              <div className="game-card-heading">
                <h3>Spider</h3>
                <span className="availability-pill">Play now</span>
              </div>
              <p>Play guaranteed-solvable 1, 2, 3, or 4 suit Spider in ranked races or solo.</p>
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
