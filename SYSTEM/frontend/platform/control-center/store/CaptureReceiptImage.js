const clamp = value => Math.min(1, Math.max(0, value));
const radians = degrees => degrees * Math.PI / 180;

export function receiptFrame(photo, angle) {
  if (!photo) return null;
  const turn = radians(angle);
  const horizontal = Math.abs(Math.cos(turn)), vertical = Math.abs(Math.sin(turn));
  return {
    angle,
    width: Math.ceil(photo.width * horizontal + photo.height * vertical - 1e-9),
    height: Math.ceil(photo.width * vertical + photo.height * horizontal - 1e-9),
  };
}

export function rectangleCorners([x, y, width, height]) {
  const right = clamp(x + width), bottom = clamp(y + height);
  return [[x, y], [right, y], [right, bottom], [x, bottom]];
}

export function validReceiptCorners(points) {
  return points.every(([ax, ay], index) => {
    const [bx, by] = points[(index + 1) % 4], [cx, cy] = points[(index + 2) % 4];
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 1e-8;
  });
}

export function rotateReceiptCrop(box, corners, photo, selectedAngle, frame) {
  if (!box || !frame || frame.angle === selectedAngle) return { box, corners };
  const source = receiptFrame(photo, selectedAngle);
  const delta = frame.angle - selectedAngle;
  const angle = radians(delta), cosine = Math.cos(angle), sine = Math.sin(angle);
  const points = corners ?? rectangleCorners(box);
  // Keep the first point at the displayed top left after a quarter turn.
  const start = (4 - Math.round(delta / 90) % 4) % 4;
  const rotated = [...points.slice(start), ...points.slice(0, start)].map(([x, y]) => {
    const left = (x - 0.5) * source.width, top = (y - 0.5) * source.height;
    return [clamp(0.5 + (left * cosine - top * sine) / frame.width),
      clamp(0.5 + (left * sine + top * cosine) / frame.height)];
  });
  const left = Math.min(...rotated.map(point => point[0])), top = Math.min(...rotated.map(point => point[1]));
  const width = Math.max(...rotated.map(point => point[0])) - left;
  const height = Math.max(...rotated.map(point => point[1])) - top;
  if (width < 0.005 || height < 0.005) return { box: null, corners: null };
  return {
    box: [left, top, width, height],
    corners: (corners || delta % 90 !== 0) && validReceiptCorners(rotated) ? rotated : null,
  };
}

export function encodeTrainingImage(source, frame = { width: source.naturalWidth, height: source.naturalHeight, angle: 0 }) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw Error("Das Trainingsfoto konnte nicht vorbereitet werden.");

  for (const [size, quality] of [[2048, 0.9], [2048, 0.76], [1400, 0.76]]) {
    const scale = Math.min(1, size / Math.max(frame.width, frame.height));
    canvas.width = Math.max(1, Math.round(frame.width * scale));
    canvas.height = Math.max(1, Math.round(frame.height * scale));
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (frame.angle) {
      context.translate(canvas.width / 2, canvas.height / 2);
      context.scale(canvas.width / frame.width, canvas.height / frame.height);
      context.rotate(radians(frame.angle));
      context.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
    } else {
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    const preview = canvas.toDataURL("image/jpeg", quality);
    const imageBase64 = preview.split(",")[1];
    if (imageBase64 && imageBase64.length <= 1_000_000) {
      return { canvas, preview, image: { mimeType: "image/jpeg", imageBase64 } };
    }
  }
  throw Error("Wähle ein kleineres Foto oder schneide es vor dem Hochladen zu.");
}

export async function encodeRotatedReceipt(photo, frame) {
  const source = new Image();
  source.src = `data:${photo.image.mimeType};base64,${photo.image.imageBase64}`;
  await source.decode().catch(() => { throw Error("Das Bonfoto konnte nicht gedreht werden."); });
  return encodeTrainingImage(source, frame).image;
}
