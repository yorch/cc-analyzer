export function LoadingNotice({ children }: { children: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      {children}
    </div>
  );
}

export function ErrorNotice({
  error,
  retry,
  label = "Couldn’t load this view.",
}: {
  error: string;
  retry: () => void;
  label?: string;
}) {
  return (
    <div className="notice error-notice" role="alert">
      <strong>{label}</strong>
      <span>{error}</span>
      <button type="button" onClick={retry}>
        Try Again
      </button>
    </div>
  );
}

export function EmptyNotice({ children }: { children: string }) {
  return (
    <p className="notice empty-notice" role="status">
      {children}
    </p>
  );
}
