export default function MatrixMark({ compact = false }) {
  return (
    <span className={`matrix-mark${compact ? " matrix-mark--compact" : ""}`} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
