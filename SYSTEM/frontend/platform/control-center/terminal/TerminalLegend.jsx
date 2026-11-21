import "./TerminalLegend.css";

const logTones = [
  ["text", "Text"],
  ["error", "Fehler"],
  ["warning", "Warnung"],
  ["system", "System"],
  ["application", "Anwendung"],
  ["login", "Login"],
];

export default function TerminalLegend({ renderItem }) {
  return (
    <ul className={`bonni-terminal-legend${renderItem ? " bonni-terminal-legend--interactive" : ""}`} role="list" aria-label="Farblegende">
      {logTones.map(([tone, label]) => (
        <li key={tone} data-terminal-tone={tone}>{renderItem ? renderItem(tone, label) : label}</li>
      ))}
    </ul>
  );
}
