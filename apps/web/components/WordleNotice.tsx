export interface WordleNoticeMessage {
  id: number;
  message: string;
}

export function WordleNotice({ notice }: { notice: WordleNoticeMessage | null }) {
  const message = notice?.message.includes("not a recognized word") ? "Not in word list" : notice?.message;

  return (
    <div aria-atomic="true" aria-live="assertive" className="wordle-notice-slot">
      {notice && (
        <div className="wordle-notice" key={notice.id}>
          {message}
        </div>
      )}
    </div>
  );
}
