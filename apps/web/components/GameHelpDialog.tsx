"use client";

import { type ReactNode, useEffect, useRef } from "react";

export function GameHelpDialog({
  eyebrow,
  title,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  return (
    <div className="confirm-backdrop game-help-backdrop" role="presentation" onClick={onClose}>
      <section
        className="game-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-help-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="game-help-heading">
          <div>
            <span>{eyebrow}</span>
            <h2 id="game-help-title">{title}</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="game-help-close" onClick={onClose} aria-label="Close help">
            ×
          </button>
        </div>
        <div className="game-help-content">{children}</div>
      </section>
    </div>
  );
}
