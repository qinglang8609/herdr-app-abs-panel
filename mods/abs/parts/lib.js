// Shared bits for every part of the studio layout: icons, colors, time,
// the shown thread (= Herdr tab) and its lead terminal, layout lookups,
// and the light/dark switch.

import { svg, image, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, agents, focused, layout, appHome, readTextFile, writeTextFile, exec, notify, setShared, theme, window as win } from "herdr";

export const MOD = "abs";
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
// 同一目录的 diff 统计：顶栏和侧栏各自都在轮询，命中缓存就别再跑一次 git。
// 5 秒的窗口足够让两个调用方合并，又不会让数字明显滞后。
const diffCache = new Map();
const DIFF_TTL = 5000;

export async function diffStat(cwd, on) {
  if (!cwd) return null;
  const cacheKey = `${on ?? ""}|${cwd}`;
  const hit = diffCache.get(cacheKey);
  if (hit && Date.now() - hit.at < DIFF_TTL) return hit.value;
  const r = await exec("git", [...READ, "diff", "--numstat", "HEAD"], { cwd, on }).catch(() => ({ code: 1 }));
  if (r.code !== 0) { diffCache.set(cacheKey, { value: null, at: Date.now() }); return null; }
  let add = 0, del = 0, files = 0;
  for (const line of r.stdout.split("\n")) {
    const [a, d] = line.split("\t");
    if (a === undefined || d === undefined) continue;
    files++;
    if (a !== "-") add += Number(a) || 0;
    if (d !== "-") del += Number(d) || 0;
  }
  const value = { add, del, files };
  diffCache.set(cacheKey, { value, at: Date.now() });
  if (diffCache.size > 64) {
    const oldest = [...diffCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, diffCache.size - 64);
    for (const [k] of oldest) diffCache.delete(k);
  }
  return value;
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

// Open a folder in VS Code / Zed / the system file window. Remote spaces go
// through ssh (the Host name comes from ~/.ssh/config, case-insensitive).
export async function openFolder(choice, dir, on) {
  if (!dir) return;
  const platform = win()?.platform;
  const list = platform === "macos"
    ? [
      ["vscode", "VS Code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
      ["zed", "Zed", "/Applications/Zed.app/Contents/MacOS/cli"],
      ["files", "文件窗口", "open"],
    ]
    : platform === "windows"
      ? [
        ["vscode", "VS Code", "code"],
        ["zed", "Zed", "zed"],
        ["files", "文件窗口", "explorer.exe"],
      ]
      : [
        ["vscode", "VS Code", "code"],
        ["zed", "Zed", "zed"],
        ["files", "文件窗口", "xdg-open"],
      ];
  const e = list.find((x) => x[0] === choice) ?? list[0];
  if (choice !== "files") setShared("studio.editor", e[0]);
  const fail = (err) => notify({
    title: `Couldn't open ${e[1]}${on ? ` on ${on}` : ""}`,
    body: String(err && (err.stderr || err.message || err)).split("\n")[0] || "Is it installed?",
    level: "error",
  });
  if (e[0] === "files") {
    exec(e[2], [dir], on ? { on } : undefined).catch(fail);
    return;
  }
  const bin = e[2];
  const script = e[0] === "zed"
    ? `host=$(awk -v k='${String(on ?? "").replace(/'/g, "")}' 'tolower($1)=="host"{for(i=2;i<=NF;i++) if(tolower($i)==k){print $i; exit}}' "$HOME/.ssh/config" 2>/dev/null); exec "${bin}" "ssh://\${host:-${on}}'${dir}'"`
    : `host=$(awk -v k='${String(on ?? "").replace(/'/g, "")}' 'tolower($1)=="host"{for(i=2;i<=NF;i++) if(tolower($i)==k){print $i; exit}}' "$HOME/.ssh/config" 2>/dev/null); exec "${bin}" --remote "ssh-remote+\${host:-${on}}" '${dir}'`;
  if (!on) {
    exec(bin, [dir]).catch(fail);
    return;
  }
  exec("sh", ["-c", script]).catch(fail);
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

// ---- 弹窗零件：abs 模块内所有表单 / 浮层一个样（abs-detail 那边有一份同样的，
// detail 是独立 mod 不能跨目录 import，两边各带，改一处要改两处）。
//
//   输入框 / 下拉  高 30 圆角 7 px 10，透明底 + border 边框；聚焦 accent 边框
//   字段          标签 11 dim 离输入框 5；字段之间 gap 12
//   按钮          高 28 圆角 7：取消 px 12 描边 input；主按钮 px 14 实心 solid（危险 ansi1）
//   按钮行        靠右 gap 8，距内容 10
//   关闭 ×        20×20 圆角 5，dim；悬停 raised 底 + foreground
// 实心按钮悬停只变淡不换底色——bg(t.hover) 是深底色，盖上去像换了按钮。
export function btnCancel(id, label, onClick) {
  const t = theme();
  return h_flex().id(id).h(28).px(12).items_center().rounded(7).border_1().border_color(t.input)
    .text_size(12).text_color(t.foreground).cursor_pointer()
    .hover((s) => s.border_color(t.muted))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick).child(label);
}
export function btnPrimary(id, label, on, onClick, danger = false) {
  const t = theme();
  return h_flex().id(id).h(28).px(14).items_center().rounded(7).text_size(12)
    .bg(on ? (danger ? t.ansi1 : t.solid) : t.raised)
    .text_color(on ? t.solid_foreground : t.dim)
    .when(on, (x) => x.cursor_pointer().hover((s) => s.opacity(0.82)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { if (on) onClick(cx); })
    .child(label);
}
export function btnClose(id, onClick) {
  const t = theme();
  return h_flex().id(id).size(20).flex_none().items_center().justify_center().rounded(5)
    .text_size(14).text_color(t.dim).cursor_pointer()
    .hover((s) => s.bg(t.raised).text_color(t.foreground))
    .on_click(onClick).child("×");
}
// 输入框 / 下拉共用的壳。onClick 有值就是可点的下拉。
export function inputShell(t, { typing = false, onClick = null } = {}, ...children) {
  const el = h_flex().h(30).w_full().px(10).items_center().rounded(7).border_1()
    .border_color(typing ? t.accent : t.border)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  if (onClick) el.cursor_pointer().on_click(onClick);
  return el.children(children);
}
// 字段：标签 + 壳。
export function field(t, label, shell) {
  return v_flex().w_full().gap(5)
    .child(div().text_size(11).text_color(t.dim).child(label))
    .child(shell);
}
// 底部按钮行：靠右、gap 8、距内容 10。
export function footer(...btns) {
  return h_flex().w_full().flex_none().justify_end().gap(8).mt(2).children(btns.filter(Boolean));
}
