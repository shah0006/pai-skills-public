
const btnStyle: CSSProperties = {
  padding: "6px 13px",
  fontSize: "0.74rem",
  fontWeight: 500,
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--surface)",
  color: "var(--muted)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

/** Visible control for the same handler as the `o` keyboard shortcut (Phase 3 B3). */
export function OpenInClientButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="open-in-client"
      title="[o] Open in Mail / Gmail"
      onClick={onClick}
      style={btnStyle}
    >
      <kbd style={{
        fontSize: "0.60rem",
        fontFamily: "monospace",
        background: "rgba(128,128,128,0.15)",
        color: "var(--muted)",
        padding: "1px 4px",
        borderRadius: "3px",
        border: "1px solid rgba(128,128,128,0.2)",
        lineHeight: 1.4,
      }}
      >
        o
      </kbd>
      Open
    </button>
  );
}
