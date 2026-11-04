// Shared bits for every part of the studio layout: icons, colors, time,
// the shown thread (= Herdr tab) and its lead terminal, layout lookups,
// and the light/dark switch.

import { svg, image } from "gpui-kit";
import { spaces, panes, agents, focused, layout, appHome, readTextFile, writeTextFile, exec, notify } from "herdr";

export const MOD = "studio";
export const icon = (name) => `mods/${MOD}/icons/${name}.svg`;

// A theme color with an alpha, for tints ("#5fc77a" + 0.14 -> "#5fc77a24").
export function alpha(color, a) {
  if (typeof color !== "string" || !color.startsWith("#")) return color;
  const hex = color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color.slice(0, 7);
  return hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
}

// Keeps a press on a control from dragging the window (blocks with window_drag).
export const own = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export function age(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function duration(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// A program's glyph: tinted one-color icons, or a full-color picture.
export function glyph(program, size, color) {
  if (!program?.icon) return null;
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).w(size).h(size).flex_none();
}

export function activeSpace() {
  return spaces().find((s) => s.active) ?? null;
}

export function activeTab() {
  return activeSpace()?.tabs.find((t) => t.active) ?? null;
}

// The terminal a thread is about: the focused one, else its agent, else the first.
export function lead(tabId, all = panes()) {
  const mine = all.filter((p) => p.tab === tabId && p.terminal);
  return mine.find((p) => p.focused) ?? mine.find((p) => p.program?.agent) ?? mine[0] ?? null;
}

// The agent the composer talks to: the focused terminal's, else the shown thread's.
export function threadAgent() {
  const f = focused();
  const all = agents();
  const tab = activeTab();
  return all.find((a) => a.address === f?.terminal) ?? all.find((a) => a.tab === tab?.id && a.focused) ?? all.find((a) => a.tab === tab?.id) ?? null;
}

// The machine a terminal lives on ("vps/t7" -> "vps"), null for this one.
export const machineOf = (address) => (address && address.includes("/") ? address.split("/")[0] : null);

export function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export const isShown = (id) => {
  const n = findNode(layout(), id);
  return Boolean(n) && !n.hidden;
};

// Opens the review column on a surface ("changes" or "files"), or closes it
// when it already shows that surface.
export function toggleReview(run, surface = "changes") {
  const open = isShown("review");
  const current = findNode(layout(), "review-body")?.active;
  if (open && current === surface) return run("layout.hide", { id: "review" });
  run("layout.select", { stack: "review-body", child: surface });
  if (!open) run("layout.show", { id: "review" });
}

// The integrated terminal: a shell split under the thread's agent. The first
// press splits one in; after that, zooming the agent hides or shows it.
export function terminalDrawer() {
  const tab = activeTab();
  const mine = panes().filter((p) => p.tab === tab?.id && p.terminal);
  const agent = mine.find((p) => p.program?.agent) ?? mine[0] ?? null;
  return { mine, agent, open: mine.length > 1 && !agent?.zoomed };
}

export function toggleTerminal(run) {
  const { mine, agent } = terminalDrawer();
  if (!agent) return run("tab.new", {});
  if (mine.length === 1) return run("pane.split", { direction: "down", pane: agent.pane });
  run("pane.zoom", { pane: agent.pane });
  if (!agent.zoomed) run("pane.focus", { pane: agent.pane });
}

// Git numbers for a folder: lines added and removed against HEAD, staged or
// not. Null outside a repo. Reads write nothing under .git.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
export async function diffStat(cwd, on) {
  if (!cwd) return null;
  const r = await exec("git", [...READ, "diff", "--numstat", "HEAD"], { cwd, on }).catch(() => ({ code: 1 }));
  if (r.code !== 0) return null;
  let add = 0, del = 0, files = 0;
  for (const line of r.stdout.split("\n")) {
    const [a, d] = line.split("\t");
    if (a === undefined || d === undefined) continue;
    files++;
    if (a !== "-") add += Number(a) || 0;
    if (d !== "-") del += Number(d) || 0;
  }
  return { add, del, files };
}

// Whether a folder is a linked git worktree ("Worktree"), the main checkout
// ("Local"), or not in git (null).
export async function checkout(cwd, on) {
  if (!cwd) return null;
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }).catch(() => ({ code: 1 }));
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => ({ code: 1 }));
  if (common.code !== 0 || top.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "local" : "worktree";
}

// ---- Light and dark ------------------------------------------------------
// The layout names a light and a dark theme; which one shows is the person's
// `appearance` in settings.json (absent: the system's). The switch cycles
// System -> Light -> Dark and writes only that one field.

export const APPEARANCES = ["system", "light", "dark"];

export async function readAppearance() {
  const text = await readTextFile(`${appHome()}/settings.json`).catch(() => null);
  try {
    const a = text ? JSON.parse(text).appearance : null;
    return a === "light" || a === "dark" ? a : "system";
  } catch {
    return "system";
  }
}

export async function writeAppearance(next) {
  const path = `${appHome()}/settings.json`;
  const text = await readTextFile(path).catch(() => null);
  let obj = {};
  try {
    obj = text ? JSON.parse(text) : {};
  } catch {
    notify({ title: "settings.json isn't valid JSON", body: "Fix it, then switch the theme again.", level: "error" });
    return false;
  }
  if (next === "system") delete obj.appearance;
  else obj.appearance = next;
  await writeTextFile(path, `${JSON.stringify(obj, null, 2)}\n`, text);
  return true;
}

// ---- Themes --------------------------------------------------------------
// The layout's two themes travel inside this mod (themes/ isn't part of a
// shared layout folder). The first copy to start puts any missing one into
// the home's themes/; Herdr picks them up from there by itself. Existing
// files are never replaced, so edits to them stick.

export async function installThemes() {
  for (const name of ["studio-light", "studio-dark"]) {
    const target = `${appHome()}/themes/${name}.json`;
    if ((await readTextFile(target).catch(() => null)) !== null) continue;
    const text = await readTextFile(`${appHome()}/mods/${MOD}/themes/${name}.json`).catch(() => null);
    if (text) await writeTextFile(target, text, null).catch(() => null);
  }
}
