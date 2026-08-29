import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpiderCard, SpiderSuit } from "@smart-rot/shared-types";
import { findSpiderAutoMoveDestination, nextSpiderHintCursor } from "./spider-hints.js";

let cardId = 0;
function card(rank: number, suit: SpiderSuit = "spades", faceUp = true): SpiderCard {
  cardId += 1;
  return { id: `auto-${cardId}`, rank, suit, faceUp };
}

test("auto move prioritizes same suit, then left-to-right within that tier", () => {
  const columns = [
    [card(6, "spades")],
    [card(7, "hearts")],
    [card(7, "spades")],
    [card(7, "spades")],
    [],
  ];
  assert.equal(findSpiderAutoMoveDestination(columns, 0, 0), 2);
});

test("auto move falls back to a different suit before the leftmost empty column", () => {
  const columns = [
    [card(6, "spades")],
    [],
    [card(7, "hearts")],
    [card(7, "diamonds")],
    [],
  ];
  assert.equal(findSpiderAutoMoveDestination(columns, 0, 0), 2);
});

test("auto move uses the leftmost empty column as its final fallback", () => {
  const columns = [[card(6)], [card(12)], [], [card(3)], []];
  assert.equal(findSpiderAutoMoveDestination(columns, 0, 0), 2);
});

test("auto move rejects a broken or face-down stack", () => {
  const broken = [[card(6), card(5, "hearts")], [card(7)], []];
  assert.equal(findSpiderAutoMoveDestination(broken, 0, 0), null);
  assert.equal(findSpiderAutoMoveDestination([[card(6, "spades", false)], []], 0, 0), null);
});

test("hints recommend an empty column after every helpful move has been shown", () => {
  const first = nextSpiderHintCursor(null, "board", 2, 4, 3);
  assert.deepEqual(first, { boardKey: "board", index: 0 });

  const second = nextSpiderHintCursor(first, "board", 2, 4, 3);
  assert.deepEqual(second, { boardKey: "board", index: 1 });

  const empty = nextSpiderHintCursor(second, "board", 2, 4, 3);
  assert.equal(empty.recommendationColumn, 4);
  assert.equal(empty.recommendation, "Use empty column 5 to rearrange a card or stack.");

  assert.deepEqual(nextSpiderHintCursor(empty, "board", 2, 4, 3), { boardKey: "board", index: 0 });
});

test("an empty column takes priority when there are no helpful moves", () => {
  const hint = nextSpiderHintCursor(null, "board", 0, 2, 4);
  assert.equal(hint.recommendationColumn, 2);
  assert.match(hint.recommendation ?? "", /empty column 3/i);
});

test("drawing is recommended only when no helpful move or empty column exists", () => {
  assert.equal(nextSpiderHintCursor(null, "board", 0, -1, 4).recommendation, "Draw another set.");
  assert.equal(
    nextSpiderHintCursor(null, "board", 0, -1, 0).recommendation,
    "No helpful moves or stock sets remain.",
  );
});
