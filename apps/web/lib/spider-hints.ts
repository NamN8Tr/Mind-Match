import type { SpiderCard, SpiderPlayerView, SpiderSuit } from "@smart-rot/shared-types";

export type SpiderHintKind = "reveal" | "same-suit";

export interface SpiderHint {
  kind: SpiderHintKind;
  fromColumn: number;
  cardIndex: number;
  toColumn: number;
  cardCount: number;
  rank: number;
  suit: SpiderSuit;
}

export interface SpiderHintCursor {
  boardKey: string;
  index: number;
  recommendation?: string;
  recommendationColumn?: number;
}

export function nextSpiderHintCursor(
  current: SpiderHintCursor | null,
  boardKey: string,
  hintCount: number,
  emptyColumn: number,
  stockDeals: number,
): SpiderHintCursor {
  const emptyRecommendation = emptyColumn >= 0
    ? {
        recommendation: `Use empty column ${emptyColumn + 1} to rearrange a card or stack.`,
        recommendationColumn: emptyColumn,
      }
    : null;

  if (hintCount === 0) {
    return {
      boardKey,
      index: 0,
      ...(emptyRecommendation ?? {
        recommendation: stockDeals > 0 ? "Draw another set." : "No helpful moves or stock sets remain.",
      }),
    };
  }
  if (current?.boardKey !== boardKey || current.recommendation) return { boardKey, index: 0 };

  const nextIndex = current.index + 1;
  if (nextIndex < hintCount) return { boardKey, index: nextIndex };
  if (emptyRecommendation) return { boardKey, index: nextIndex, ...emptyRecommendation };
  return { boardKey, index: 0 };
}

function isMovable(cards: SpiderCard[]): boolean {
  return cards.every(
    (card, index) =>
      card.faceUp &&
      (index === 0 ||
        (cards[index - 1]!.rank === card.rank + 1 && cards[index - 1]!.suit === card.suit)),
  );
}

/**
 * Returns the deepest card that can carry the complete exposed same-suit run.
 * Hinting a smaller suffix (for example, the 4 from a movable 5-4 run) is
 * technically legal but needlessly breaks useful work the player has made.
 */
function deepestMovableRunStart(column: SpiderCard[]): number {
  let cardIndex = column.length - 1;
  if (cardIndex < 0 || !column[cardIndex]?.faceUp) return -1;

  while (cardIndex > 0) {
    const card = column[cardIndex]!;
    const previous = column[cardIndex - 1]!;
    if (!previous.faceUp || previous.suit !== card.suit || previous.rank !== card.rank + 1) break;
    cardIndex -= 1;
  }
  return cardIndex;
}

/**
 * Chooses the deterministic destination for a tapped card or stack: extend a
 * same-suit run, then use another suit of the required rank, then an empty
 * column. Array order provides the left-to-right tie break in every tier.
 */
export function findSpiderAutoMoveDestination(
  columns: SpiderCard[][],
  fromColumn: number,
  cardIndex: number,
): number | null {
  const source = columns[fromColumn];
  const moving = source?.slice(cardIndex) ?? [];
  const card = moving[0];
  if (!card || !isMovable(moving)) return null;

  const rankedTargets = columns
    .map((column, index) => ({ index, card: column.at(-1) }))
    .filter(({ index, card: target }) =>
      index !== fromColumn && target?.faceUp && target.rank === card.rank + 1,
    );
  const sameSuit = rankedTargets.find(({ card: target }) => target?.suit === card.suit);
  if (sameSuit) return sameSuit.index;
  const differentSuit = rankedTargets.find(({ card: target }) => target?.suit !== card.suit);
  if (differentSuit) return differentSuit.index;

  const emptyColumn = columns.findIndex((column, index) => index !== fromColumn && column.length === 0);
  return emptyColumn >= 0 ? emptyColumn : null;
}

/**
 * Hints intentionally favor progress: first moves that expose a hidden card,
 * then moves that extend a same-suit run. Neutral shuffles are omitted.
 */
export function getSpiderHintMoves(player: SpiderPlayerView): SpiderHint[] {
  const reveal: SpiderHint[] = [];
  const sameSuit: SpiderHint[] = [];

  player.columns.forEach((source, fromColumn) => {
    const cardIndex = deepestMovableRunStart(source);
    if (cardIndex < 0) return;
    const card = source[cardIndex]!;
    const moving = source.slice(cardIndex);

    player.columns.forEach((target, toColumn) => {
      if (fromColumn === toColumn) return;
      const targetCard = target.at(-1);
      if (targetCard && (!targetCard.faceUp || targetCard.rank !== card.rank + 1)) return;

      const exposesHiddenCard = cardIndex > 0 && source[cardIndex - 1]?.faceUp === false;
      const extendsSameSuit = targetCard?.suit === card.suit;
      if (!exposesHiddenCard && !extendsSameSuit) return;

      const hint: SpiderHint = {
        kind: exposesHiddenCard ? "reveal" : "same-suit",
        fromColumn,
        cardIndex,
        toColumn,
        cardCount: moving.length,
        rank: card.rank,
        suit: card.suit,
      };
      (exposesHiddenCard ? reveal : sameSuit).push(hint);
    });
  });

  return [...reveal, ...sameSuit];
}
