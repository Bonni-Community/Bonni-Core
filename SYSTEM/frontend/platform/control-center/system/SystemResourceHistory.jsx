const plotWidth = 600;
const plotHeight = 100;
const ticks = [0, 25, 50, 75, 100];

function plotSeries(points, field, start, end, interval) {
  let previous = null;
  let path = "";
  let last = null;
  for (const point of points) {
    const value = point[field];
    if (!Number.isFinite(point.at) || point.at < start || point.at > end || !Number.isFinite(value)) {
      previous = null;
      continue;
    }
    const x = plotWidth * (point.at - start) / (end - start);
    const y = plotHeight * (1 - Math.max(0, Math.min(100, value)) / 100);
    const command = previous !== null && point.at - previous <= interval * 2 ? "L" : "M";
    path += `${command}${x.toFixed(2)},${y.toFixed(2)}`;
    previous = point.at;
    last = { x, y };
  }
  return { path, last };
}

export default function SystemResourceHistory({ history, checkedAt }) {
  const duration = history?.durationMs || 15 * 60 * 1_000;
  const interval = history?.intervalMs || 5_000;
  const end = Date.parse(checkedAt);
  const start = end - duration;
  const points = Array.isArray(history?.points) && Number.isFinite(end) ? history.points : [];
  const cpu = plotSeries(points, "cpuPercent", start, end, interval);
  const memory = plotSeries(points, "memoryPercent", start, end, interval);

  return (
    <section className="bonni-resource-card bonni-monitor-history" aria-labelledby="bonni-monitor-history">
      <header>
        <h2 id="bonni-monitor-history">CPU- und RAM-Verlauf</h2>
        <small>Letzte 15 Minuten</small>
      </header>
      <div className="bonni-monitor-history__legend">
        <span data-series="cpu">CPU</span>
        <span data-series="memory">RAM</span>
      </div>
      {cpu.last || memory.last ? (
        <div className="bonni-monitor-history__plot">
          <div className="bonni-monitor-history__percent" aria-hidden="true">
            <span>100 %</span><span>50 %</span><span>0 %</span>
          </div>
          <svg
            role="img"
            aria-label="CPU- und RAM-Auslastung in Prozent in den letzten 15 Minuten"
            viewBox={`0 0 ${plotWidth} ${plotHeight}`}
            preserveAspectRatio="none"
          >
            {ticks.map(y => <line key={y} x1="0" x2={plotWidth} y1={y} y2={y} />)}
            {[[cpu, "cpu"], [memory, "memory"]].map(([series, name]) => series.last && (
              <g key={name} data-series={name}>
                <path d={series.path} vectorEffect="non-scaling-stroke" />
                <circle cx={series.last.x} cy={series.last.y} r="2" />
              </g>
            ))}
          </svg>
          <div className="bonni-monitor-history__minutes" aria-hidden="true">
            <span>−15 Min.</span><span>−10 Min.</span><span>−5 Min.</span><span>Jetzt</span>
          </div>
        </div>
      ) : <p>Erste Messwerte werden gesammelt …</p>}
    </section>
  );
}
