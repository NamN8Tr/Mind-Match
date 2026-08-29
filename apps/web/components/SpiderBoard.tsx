"use client";

import type {
  SpiderCard,
  SpiderMove,
  SpiderPlayerView,
  SpiderSuit,
} from "@smart-rot/shared-types";
import Image from "next/image";
import { type DragEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  findSpiderAutoMoveDestination,
  getSpiderHintMoves,
  nextSpiderHintCursor,
  type SpiderHint,
  type SpiderHintCursor,
} from "../lib/spider-hints";

interface Selection {
  column: number;
  cardIndex: number;
  moveCount: number;
}

function setStackDragImage(event: DragEvent<HTMLButtonElement>, cardIndex: number): void {
  const column = event.currentTarget.parentElement;
  if (!column) return;

  const cards = Array.from(column.querySelectorAll<HTMLElement>(":scope > .spider-card")).slice(cardIndex);
  if (cards.length === 0) return;

  const preview = document.createElement("div");
  const cardRect = event.currentTarget.getBoundingClientRect();
  preview.className = "spider-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.style.width = `${cardRect.width}px`;
  cards.forEach((card) => preview.append(card.cloneNode(true)));
  document.body.append(preview);

  const offsetX = Math.max(0, Math.min(cardRect.width, event.clientX - cardRect.left));
  const offsetY = Math.max(0, Math.min(cardRect.height, event.clientY - cardRect.top));
  event.dataTransfer.setDragImage(preview, offsetX, offsetY);
  window.setTimeout(() => preview.remove(), 0);
}

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function isMovable(column: SpiderCard[], cardIndex: number): boolean {
  return column.slice(cardIndex).every(
    (card, index, cards) =>
      card.faceUp &&
      (index === 0 ||
        (cards[index - 1]!.rank === card.rank + 1 && cards[index - 1]!.suit === card.suit)),
  );
}

function hintDescription(hint: SpiderHint): string {
  const card = hint.cardCount === 1
    ? `${rankLabel(hint.rank)}${SUIT_SYMBOL[hint.suit]}`
    : `${hint.cardCount}-card ${SUIT_SYMBOL[hint.suit]} stack`;
  const reason = hint.kind === "reveal" ? "reveal a face-down card" : "extend a same-suit run";
  return `Move ${card} from column ${hint.fromColumn + 1} to column ${hint.toColumn + 1} to ${reason}.`;
}

const SUIT_SYMBOL: Record<SpiderSuit, string> = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
};

const COURT_ART: Record<11 | 12 | 13, string> = {
  11: "/images/spider/court-jack-v2.png",
  12: "/images/spider/court-queen-v2.png",
  13: "/images/spider/court-king-v2.png",
};

const COURT_NAME: Record<11 | 12 | 13, string> = {
  11: "jack",
  12: "queen",
  13: "king",
};

function CourtCardArt({ rank }: { rank: 11 | 12 | 13 }) {
  return (
    <span aria-hidden="true" className={`spider-card-court spider-card-court-${COURT_NAME[rank]}`}>
      <Image
        alt=""
        draggable={false}
        fill
        sizes="(max-width: 680px) 32px, 64px"
        src={COURT_ART[rank]}
      />
    </span>
  );
}

export function SpiderBoard({
  player,
  disabled,
  pending,
  showActions = true,
  onMove,
  onLocalError,
}: {
  player: SpiderPlayerView;
  disabled: boolean;
  pending: boolean;
  showActions?: boolean;
  onMove: (move: SpiderMove) => void;
  onLocalError: (message: string) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState<Selection | null>(null);
  const [hintState, setHintState] = useState<SpiderHintCursor | null>(null);
  const [hintAnimationNonce, setHintAnimationNonce] = useState(0);
  const cardElements = useRef(new Map<string, HTMLButtonElement>());
  const columnElements = useRef(new Map<number, HTMLDivElement>());
  const hintFlightElement = useRef<HTMLDivElement | null>(null);
  const previousCardRects = useRef(new Map<string, DOMRect>());
  const previousCardClones = useRef(new Map<string, HTMLButtonElement>());
  const previousStockLength = useRef(player.stock.length);
  const nextStockDeal = useRef(new Map((player.stock[0] ?? []).map((card, index) => [card.id, index])));
  const stockPileElement = useRef<HTMLSpanElement | null>(null);
  const boardKey = `${player.moveCount}:${player.stock.length}:${player.completedRuns}`;
  const currentSelection = selection?.moveCount === player.moveCount ? selection : null;
  const currentDragging = dragging?.moveCount === player.moveCount ? dragging : null;
  const hints = useMemo(() => getSpiderHintMoves(player), [player]);
  const currentHint = hintState?.boardKey === boardKey && !hintState.recommendation && hints.length > 0
    ? hints[hintState.index % hints.length]
    : null;
  const hintMessage = currentHint
    ? hintDescription(currentHint)
    : hintState?.boardKey === boardKey
      ? hintState.recommendation
      : null;

  useLayoutEffect(() => {
    const currentRects = new Map<string, DOMRect>();
    const currentClones = new Map<string, HTMLButtonElement>();
    cardElements.current.forEach((element, cardId) => {
      currentRects.set(cardId, element.getBoundingClientRect());
      currentClones.set(cardId, element.cloneNode(true) as HTMLButtonElement);
    });

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dealtFromStock = previousStockLength.current === player.stock.length + 1;
    const returnedToStock = previousStockLength.current + 1 === player.stock.length;
    const stockRect = dealtFromStock || returnedToStock
      ? stockPileElement.current?.getBoundingClientRect()
      : undefined;

    if (!reducedMotion && returnedToStock && stockRect) {
      const returnedDeal = new Map((player.stock[0] ?? []).map((card, index) => [card.id, index]));
      returnedDeal.forEach((columnIndex, cardId) => {
        const previousRect = previousCardRects.current.get(cardId);
        const cardClone = previousCardClones.current.get(cardId);
        if (!previousRect || !cardClone || currentRects.has(cardId)) return;

        cardClone.classList.remove("selected", "dragging", "hint-source");
        cardClone.removeAttribute("id");
        cardClone.style.removeProperty("z-index");

        const flight = document.createElement("div");
        flight.className = "spider-stock-return-flight";
        flight.setAttribute("aria-hidden", "true");
        flight.style.left = `${previousRect.left}px`;
        flight.style.top = `${previousRect.top}px`;
        flight.style.width = `${previousRect.width}px`;
        flight.style.height = `${previousRect.height}px`;
        flight.append(cardClone);

        const cardBack = document.createElement("span");
        cardBack.className = "spider-stock-return-back";
        flight.append(cardBack);
        document.body.append(flight);

        const deltaX = stockRect.left - previousRect.left;
        const deltaY = stockRect.top - previousRect.top;
        const destinationScale = Math.min(1, 46 / previousRect.width);
        const delay = (player.columns.length - 1 - columnIndex) * 24;
        const timing: KeyframeAnimationOptions = {
          duration: 540,
          delay,
          easing: "cubic-bezier(0.3, 0.02, 0.2, 1)",
          fill: "both",
        };
        const flightAnimation = flight.animate(
          [
            { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1, offset: 0 },
            {
              transform: `translate3d(${deltaX * 0.48}px, ${deltaY * 0.48}px, 0) scale(0.92)`,
              opacity: 1,
              offset: 0.48,
            },
            {
              transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${destinationScale})`,
              opacity: 1,
              offset: 0.9,
            },
            {
              transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${destinationScale * 0.98})`,
              opacity: 0,
              offset: 1,
            },
          ],
          timing,
        );
        cardClone.animate(
          [
            { opacity: 1, offset: 0 },
            { opacity: 1, offset: 0.54 },
            { opacity: 0, offset: 0.7 },
            { opacity: 0, offset: 1 },
          ],
          timing,
        );
        cardBack.animate(
          [
            { opacity: 0, offset: 0 },
            { opacity: 0, offset: 0.54 },
            { opacity: 1, offset: 0.7 },
            { opacity: 1, offset: 1 },
          ],
          timing,
        );
        const removeFlight = () => flight.remove();
        void flightAnimation.finished.then(removeFlight, removeFlight);
      });
    }

    if (!reducedMotion && previousCardRects.current.size > 0) {
      currentRects.forEach((currentRect, cardId) => {
        const element = cardElements.current.get(cardId);
        if (!element) return;

        const previousRect = previousCardRects.current.get(cardId);
        const stockColumn = dealtFromStock ? nextStockDeal.current.get(cardId) : undefined;
        const origin = previousRect ?? (stockColumn !== undefined ? stockRect : undefined);
        if (!origin) return;

        const originX = origin.left + origin.width / 2;
        const originY = origin.top + origin.height / 2;
        const destinationX = currentRect.left + currentRect.width / 2;
        const destinationY = currentRect.top + currentRect.height / 2;
        const deltaX = originX - destinationX;
        const deltaY = originY - destinationY;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

        element.getAnimations().forEach((animation) => animation.cancel());
        element.style.zIndex = "20";
        const fromStock = !previousRect && stockColumn !== undefined;
        const animation = element.animate(
          fromStock
            ? [
                {
                  transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(0.72)`,
                  opacity: 0,
                  offset: 0,
                },
                {
                  transform: `translate3d(${deltaX * 0.72}px, ${deltaY * 0.72}px, 0) scale(0.78)`,
                  opacity: 0,
                  offset: 0.22,
                },
                {
                  transform: `translate3d(${deltaX * 0.46}px, ${deltaY * 0.46}px, 0) scale(0.86)`,
                  opacity: 0.82,
                  offset: 0.48,
                },
                { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1, offset: 1 },
              ]
            : [
                { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1)`, opacity: 1 },
                { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
              ],
          {
            duration: fromStock ? 430 : 280,
            delay: fromStock ? stockColumn * 34 : 0,
            easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
            fill: "both",
          },
        );
        const clearAnimationLayer = () => element.style.removeProperty("z-index");
        void animation.finished.then(clearAnimationLayer, clearAnimationLayer);
      });
    }

    previousCardRects.current = currentRects;
    previousCardClones.current = currentClones;
    previousStockLength.current = player.stock.length;
    nextStockDeal.current = new Map((player.stock[0] ?? []).map((card, index) => [card.id, index]));
  }, [player.columns.length, player.moveCount, player.stock]);

  useLayoutEffect(() => {
    hintFlightElement.current?.remove();
    hintFlightElement.current = null;
    if (!currentHint) return;

    const sourceColumnElement = columnElements.current.get(currentHint.fromColumn);
    const destinationColumnElement = columnElements.current.get(currentHint.toColumn);
    if (!sourceColumnElement || !destinationColumnElement) return;
    const sourceElements = Array.from(
      sourceColumnElement.querySelectorAll<HTMLButtonElement>(":scope > .spider-card"),
    ).slice(currentHint.cardIndex);
    const sourceElement = sourceElements[0];
    const destinationElements = Array.from(
      destinationColumnElement.querySelectorAll<HTMLButtonElement>(":scope > .spider-card"),
    );
    const destinationElement = destinationElements.at(-1);
    if (!sourceElement) return;

    const sourceRect = sourceElement.getBoundingClientRect();
    const destinationRect = (destinationElement ?? destinationColumnElement).getBoundingClientRect();
    const destinationOffset = destinationElement ? Math.min(34, destinationRect.height * 0.36) : 0;
    const deltaX = destinationRect.left - sourceRect.left;
    const deltaY = destinationRect.top + destinationOffset - sourceRect.top;

    const preview = document.createElement("div");
    preview.className = "spider-hint-flight";
    preview.setAttribute("aria-hidden", "true");
    preview.style.left = `${sourceRect.left}px`;
    preview.style.top = `${sourceRect.top}px`;
    preview.style.width = `${sourceRect.width}px`;
    for (const element of sourceElements) {
      const clone = element.cloneNode(true) as HTMLButtonElement;
      clone.classList.remove("selected", "dragging", "hinted");
      clone.removeAttribute("id");
      clone.style.removeProperty("z-index");
      preview.append(clone);
    }
    document.body.append(preview);
    sourceElements.forEach((element) => element.classList.add("hint-source"));
    hintFlightElement.current = preview;

    const animation = preview.animate(
      [
        { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1, offset: 0 },
        { transform: `translate3d(${deltaX * 0.52}px, ${deltaY * 0.52}px, 0) scale(1.025)`, opacity: 1, offset: 0.46 },
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1)`, opacity: 1, offset: 0.76 },
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1)`, opacity: 1, offset: 0.9 },
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(0.98)`, opacity: 0, offset: 1 },
      ],
      { duration: 1_100, easing: "cubic-bezier(0.2, 0.82, 0.2, 1)", fill: "forwards" },
    );
    const removePreview = () => {
      sourceElements.forEach((element) => element.classList.remove("hint-source"));
      preview.remove();
      if (hintFlightElement.current === preview) hintFlightElement.current = null;
    };
    void animation.finished.then(removePreview, removePreview);
    return () => {
      animation.cancel();
      removePreview();
    };
  }, [boardKey, currentHint, hintAnimationNonce]);

  function submitDestination(columnIndex: number): void {
    if (!currentSelection || disabled || pending || currentSelection.column === columnIndex) return;
    onMove({
      type: "move",
      fromColumn: currentSelection.column,
      cardIndex: currentSelection.cardIndex,
      toColumn: columnIndex,
    });
  }

  function chooseCard(columnIndex: number, cardIndex: number): void {
    if (disabled || pending) return;

    const column = player.columns[columnIndex]!;
    if (!column[cardIndex]?.faceUp) {
      setSelection(null);
      onLocalError("That card is face down");
      return;
    }
    if (!isMovable(column, cardIndex)) {
      setSelection(null);
      onLocalError("Held stacks must descend in one suit");
      return;
    }

    const destination = findSpiderAutoMoveDestination(player.columns, columnIndex, cardIndex);
    setSelection(null);
    if (destination === null) {
      onLocalError("That card or stack has no valid destination");
      return;
    }
    onMove({ type: "move", fromColumn: columnIndex, cardIndex, toColumn: destination });
  }

  function requestHint(): void {
    if (disabled || pending) return;
    const emptyColumn = player.columns.findIndex((column) => column.length === 0);
    setHintAnimationNonce((current) => current + 1);
    setHintState((current) => nextSpiderHintCursor(
      current,
      boardKey,
      hints.length,
      emptyColumn,
      player.stock.length,
    ));
  }

  return (
    <div className="spider-board-wrap">
      <div className="spider-tabletop">
        <div className="spider-completed-area" aria-label={`${player.completedRuns} completed runs`}>
          <span className="spider-area-label">Completed</span>
          <div className="spider-run-slots">
            {player.completedSuits.length === 0 ? (
              <span className="spider-run-slot empty" aria-label="No completed runs yet" />
            ) : (
              player.completedSuits.map((suit, index) => (
                <span
                  className={`spider-run-slot complete spider-card-${suit}`}
                  aria-label={`Completed ${suit} run ${index + 1}`}
                  key={index}
                >
                  <b>A</b><i aria-hidden="true">{SUIT_SYMBOL[suit]}</i>
                </span>
              ))
            )}
          </div>
          <strong>{player.completedRuns}/8 runs</strong>
        </div>

        <button
          type="button"
          className="spider-stock"
          onClick={() => onMove({ type: "draw" })}
          disabled={disabled || pending || player.stock.length === 0}
          aria-label={player.stock.length > 0 ? `Draw another set; ${player.stock.length} remaining` : "No stock sets remaining"}
        >
          <span className="spider-area-label">Stock</span>
          <span
            className={`spider-stock-pile${player.stock.length === 0 ? " empty" : ""}`}
            aria-hidden="true"
            ref={stockPileElement}
          >
            {player.stock.map((_, index) => (
              <i
                key={index}
                style={{
                  left: `${(player.stock.length - 1 - index) * 12}px`,
                  zIndex: index + 1,
                }}
              />
            ))}
          </span>
          <strong>{player.stock.length} {player.stock.length === 1 ? "deal" : "deals"}</strong>
        </button>
      </div>

      <div className="spider-board" aria-label="Spider tableau">
        {player.columns.map((column, columnIndex) => {
          return (
            <div
              className={`spider-column${currentSelection?.column === columnIndex ? " has-selection" : ""}`}
              key={columnIndex}
              ref={(element) => {
                if (element) columnElements.current.set(columnIndex, element);
                else columnElements.current.delete(columnIndex);
              }}
              onDragOver={(event) => {
                if (currentSelection && !disabled && !pending) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                submitDestination(columnIndex);
                setDragging(null);
              }}
            >
              {column.length === 0 ? (
                <button
                  type="button"
                  className={`spider-empty-column${currentSelection ? " can-receive" : ""}`}
                  aria-label={`Move held stack to empty column ${columnIndex + 1}`}
                  disabled={!currentSelection || disabled || pending}
                  onClick={() => submitDestination(columnIndex)}
                >
                  <span>♠</span>
                </button>
              ) : (
                column.map((card, cardIndex) => {
                  const selected = currentSelection?.column === columnIndex && cardIndex >= currentSelection.cardIndex;
                  const dragged = currentDragging?.column === columnIndex && cardIndex >= currentDragging.cardIndex;
                  const movable = card.faceUp && isMovable(column, cardIndex);
                  return (
                    <button
                      type="button"
                      className={`spider-card ${card.faceUp ? "face-up" : "face-down"} spider-card-${card.suit}${card.suit === "hearts" || card.suit === "diamonds" ? " red" : ""}${selected ? " selected" : ""}${dragged ? " dragging" : ""}`}
                      aria-label={card.faceUp
                        ? `${rankLabel(card.rank)} of ${card.suit}, column ${columnIndex + 1}${selected ? ", held" : ""}`
                        : `Face-down card, column ${columnIndex + 1}`}
                      key={card.id}
                      ref={(element) => {
                        if (element) cardElements.current.set(card.id, element);
                        else cardElements.current.delete(card.id);
                      }}
                      onClick={() => chooseCard(columnIndex, cardIndex)}
                      disabled={disabled || pending || !card.faceUp}
                      draggable={!disabled && !pending && movable}
                      onDragStart={(event) => {
                        if (!movable) {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", `${columnIndex}:${cardIndex}`);
                        setStackDragImage(event, cardIndex);
                        setSelection({ column: columnIndex, cardIndex, moveCount: player.moveCount });
                        setDragging({ column: columnIndex, cardIndex, moveCount: player.moveCount });
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      {card.faceUp ? (
                        <>
                          <span className="spider-card-corner">
                            <b className="spider-card-rank">{rankLabel(card.rank)}</b>
                            <i className="spider-card-suit" aria-hidden="true">{SUIT_SYMBOL[card.suit]}</i>
                          </span>
                          {card.rank >= 11 ? (
                            <CourtCardArt rank={card.rank as 11 | 12 | 13} />
                          ) : (
                            <span className="spider-card-center-suit" aria-hidden="true">{SUIT_SYMBOL[card.suit]}</span>
                          )}
                        </>
                      ) : <span className="spider-card-back-mark" aria-hidden="true">SR</span>}
                    </button>
                  );
                })
              )}
            </div>
          );
        })}
      </div>

      {showActions && (
        <div className="spider-action-bar" aria-label="Spider actions">
          <button
            type="button"
            className="spider-action-button"
            onClick={() => onMove({ type: "undo" })}
            disabled={disabled || pending || !player.canUndo}
          >
            <span aria-hidden="true">↶</span>
            <strong>Take back</strong>
            <small>Unlimited</small>
          </button>
          <div className="spider-action-status" aria-live="polite">
            {hintMessage ? (
              <p className={currentHint ? "spider-hint-message" : "spider-hint-message recommendation"}>
                <span aria-hidden="true">{currentHint ? "✦" : "↧"}</span> {hintMessage}
                {hints.length > 1 && currentHint ? <small>Hint {hintState!.index + 1} of {hints.length}</small> : null}
              </p>
            ) : (
              <p className="spider-board-help">
                <strong>{player.completedRuns}/8 runs</strong>
                <small>{currentSelection ? "Cards held" : `${player.moveCount} actions`}</small>
              </p>
            )}
          </div>
          <button
            type="button"
            className="spider-action-button hint"
            onClick={requestHint}
            disabled={disabled || pending}
          >
            <span aria-hidden="true">✦</span>
            <strong>Hint</strong>
            <small>Unlimited</small>
          </button>
        </div>
      )}
    </div>
  );
}
