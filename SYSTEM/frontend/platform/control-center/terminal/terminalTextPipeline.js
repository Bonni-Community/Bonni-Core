import { saveTerminalOutput } from "./terminalFiles.js";
import { filterTerminalOutput } from "./terminalLinuxCommands.js";

function lineText(row) {
  return typeof row === "string" ? row : row.text;
}

function sortLines(lines, { reverse, numeric, unique }) {
  const collator = new Intl.Collator("de");
  const number = text => Number(/^\s*(-?\d+(?:\.\d+)?|-?\.\d+)/u.exec(text)?.[1] ?? 0);
  const compare = (left, right) => numeric
    ? Math.sign(number(lineText(left)) - number(lineText(right))) || 0
    : collator.compare(lineText(left), lineText(right));
  lines.sort((left, right) => (reverse ? -1 : 1) * compare(left, right));
  return unique ? lines.filter((line, index) => index === 0 || compare(line, lines[index - 1]) !== 0) : lines;
}

function cutLines(lines, { mode, delimiter, ranges }) {
  const selected = (_value, index) => ranges.some(([first, last]) => first <= index + 1 && index + 1 <= last);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function cut(text) {
    if (mode === "fields") {
      return text.includes(delimiter) ? text.split(delimiter).filter(selected).join(delimiter) : text;
    }
    if (mode === "characters") return [...text].filter(selected).join("");
    try {
      return decoder.decode(encoder.encode(text).filter(selected));
    } catch {
      throw new Error("cut -b hat ein UTF-8-Zeichen geteilt. Verwende cut -c für Zeichenpositionen.");
    }
  }
  return lines.map(row => typeof row === "string" ? cut(row) : { ...row, text: cut(row.text) });
}

export async function executeTerminalTextPipeline(command, result, context) {
  let output = result.rows ?? result;
  let exactText = command.kind === "cat" || command.kind === "echo";
  for (const stage of command.pipes) {
    if (stage.kind === "tee") {
      const text = typeof output === "string" ? output : output.map(lineText).join("\n");
      const content = exactText || !text || text.endsWith("\n") ? text : `${text}\n`;
      await saveTerminalOutput(stage, content, context);
      continue;
    }
    if (stage.kind === "grep") {
      output = filterTerminalOutput(output, stage);
    } else {
      const lines = typeof output === "string"
        ? (output ? output.replace(/\r?\n$/u, "").split(/\r?\n/u) : [])
        : [...output];
      const processed = stage.kind === "sort" ? sortLines(lines, stage) : cutLines(lines, stage);
      output = typeof output === "string" ? processed.join("\n") : processed;
    }
    exactText = false;
  }
  return Array.isArray(output) ? { rows: output } : output;
}
