import { useRef, useState } from "react";
import { rectangleCorners, validReceiptCorners } from "./CaptureReceiptImage.js";

const labels = ["Ecke oben links", "Ecke oben rechts", "Ecke unten rechts", "Ecke unten links"];
const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const clamp = value => Math.min(1, Math.max(0, value));

function moveCorner(points, index, dx, dy) {
  const [x, y] = points[index];
  const next = [clamp(x + dx), clamp(y + dy)];
  if (next[0] === x && next[1] === y) return points;
  const moved = points.map((point, i) => i === index ? next : point);
  return validReceiptCorners(moved) ? moved : null;
}

export default function CaptureReceiptCrop({ box, corners, photo, surface, disabled, onChange }) {
  const drag = useRef(null);
  const [draft, setDraft] = useState(null);
  const saved = corners ?? rectangleCorners(box);
  const points = draft ?? saved;

  function move(event) {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    const rect = surface.current.getBoundingClientRect();
    const next = moveCorner(active.points, active.index,
      (event.clientX - active.x) / rect.width, (event.clientY - active.y) / rect.height);
    // Keep the last valid outline if the pointer crosses an adjacent edge.
    if (next) {
      active.latest = next;
      setDraft(next);
    }
  }

  function finish(event, save) {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    if (save) move(event);
    drag.current = null;
    setDraft(null);
    if (save && active.latest !== active.points) onChange(active.latest);
  }

  return <>
    <svg className="store-capture-training__crop" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={points.map(([left, top]) => `${left * 100},${top * 100}`).join(" ")}
        vectorEffect="non-scaling-stroke" />
    </svg>
    {points.map(([left, top], index) => <button key={labels[index]} type="button"
      className="store-capture-training__corner" style={{ left: `${left * 100}%`, top: `${top * 100}%` }}
      aria-label={labels[index]} aria-describedby="capture-receipt-corner-help" disabled={disabled}
      onPointerDown={event => {
        event.stopPropagation();
        if (event.button !== 0 || drag.current) return;
        drag.current = { id: event.pointerId, index, x: event.clientX, y: event.clientY, points: saved, latest: saved };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={event => finish(event, true)}
      onPointerCancel={event => finish(event, false)}
      onLostPointerCapture={event => finish(event, false)}
      onKeyDown={event => {
        const direction = arrows[event.key];
        if (!direction) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const next = moveCorner(saved, index, direction[0] * step / photo.width, direction[1] * step / photo.height);
        if (next && next !== saved) onChange(next);
      }} />)}
  </>;
}
