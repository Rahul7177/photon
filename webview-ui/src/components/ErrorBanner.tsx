export function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="banner error-banner">
      <span className="error-text">{message}</span>
      <button className="banner-close" title="Dismiss" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
