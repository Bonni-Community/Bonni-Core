import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesheet = readFile(new URL("./CoreUpdatePage.css", import.meta.url), "utf8");

test("update page uses a flat hero without glow or blur effects", async () => {
  const css = await stylesheet;

  assert.match(css, /\.cc-update-page-hero\s*\{[\s\S]*?background:\s*#1b2028;/);
  assert.doesNotMatch(css, /radial-gradient|linear-gradient|box-shadow|(?:backdrop-)?filter\s*:/);
  assert.match(css, /\.cc-update-page-progress\s*>\s*span\s*\{[\s\S]*?background:\s*#ff6b2f;/);
});

test("update hero presents one unclipped Bonni Core system update", async () => {
  const css = await stylesheet;

  assert.match(css, /\.cc-core-update-page\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.cc-core-update-page,\s*\.cc-core-update-page \*\s*\{\s*box-sizing:\s*border-box;/);
  assert.match(css, /\.cc-update-page-hero__content\s*\{[\s\S]*?display:\s*block;/);
  assert.match(css, /\.cc-update-page-hero__content\s*>\s*div\s*\{\s*max-width:\s*760px;/);
  assert.doesNotMatch(css, /\.cc-update-page-version-grid/);
  assert.match(css, /\.cc-update-page-current-step\s*\{[\s\S]*?border-left:\s*4px solid #ff6b2f;/);
});
