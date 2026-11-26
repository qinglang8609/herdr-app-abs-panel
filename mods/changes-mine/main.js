// 源码管理面板：多仓库、暂存/取消暂存/丢弃、提交、推送拉取、提交历史与仓库/分支切换。
// 行为对齐 VS Code 的 Source Control：仓库发现当前目录所属仓库 + 一层子目录
// （跟 git.repositoryScanMaxDepth 的默认值一致）。diff 不在面板里挤，点文件弹窗看。
//
// 内置 changes 每次启动会被 app 重置（installed.json 哈希校验），所以这份是独立 mod，
// 布局里替换掉它（见 herdr-agent2api/sync-layout.sh 的 RENAMED 表）。
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, settings, window as winInfo, props, openOverlay, closeOverlay, shared, setShared } from "herdr";

const MAX_REPOS = 16;
const LOG_LIMIT = 30;
const POLL_LOCAL = 8000;
const POLL_REMOTE = 30000;

const ICONS = (name, color, px = 14) => svg(`mods/changes-mine/icons/${name}.svg`).size(px).flex_none().text_color(color);

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// 读操作不写 .git（不刷 index、不加锁、不落 fsmonitor 标记），否则目录监听会自己触发自己。
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const wideGlyph = /[\p{Ideographic}\p{Emoji_Presentation}\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/gu;

function displayColumns(text) {
  let columns = text.length;
  for (const glyph of text.match(wideGlyph) ?? []) if (glyph.length === 1) columns++;
  return columns;
}

const rowHeight = (size) => Math.ceil(size * 1.8), charWidth = (size) => size * 0.64;
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// 提交时间写短，不跟 git 的 %cr 走（那个跟系统语言变，也太长）。
function relTime(seconds) {
  const ms = Number(seconds) * 1000;
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  const t = new Date(ms);
  return `${t.getMonth() + 1}-${t.getDate()}`;
}

const git = (root, on, args) => exec("git", [...READ, ...args], { cwd: root, on });

async function discoverRepos(cwd, on) {
  const roots = [];
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (top?.code === 0) roots.push(top.stdout.trim());
  const scan = await exec("sh", ["-c", 'find "$1" -maxdepth 2 -name .git -not -path "*/node_modules/*" -print 2>/dev/null', "repos", cwd], { on }).catch(() => null);
  for (const line of (scan?.stdout ?? "").split("\n")) {
    const p = line.trim();
    if (!p.endsWith("/.git")) continue;
    const root = p.slice(0, -5);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots.slice(0, MAX_REPOS);
}

// porcelain v1 前两位：X = 暂存区，Y = 工作区；`??` 是未跟踪。
function parseStatus(stdout) {
  const staged = [], unstaged = [];
  const statusOf = (c) => (c === "A" ? "A" : c === "D" ? "D" : c === "U" ? "U" : "M");
  for (const entry of stdout.split("\0").filter(Boolean)) {
    const x = entry[0], y = entry[1], path = entry.slice(3);
    if (x === "?" && y === "?") { unstaged.push({ path, status: "A", fresh: true }); continue; }
    if (x !== " " && x !== "?") staged.push({ path, status: statusOf(x) });
    if (y !== " " && y !== "?") unstaged.push({ path, status: statusOf(y) });
  }
  return { staged, unstaged };
}

async function numstat(root, on, cached) {
  const r = await git(root, on, ["diff", ...(cached ? ["--cached"] : []), "--numstat", "-z", "--no-renames"]).catch(() => null);
  const map = {};
  for (const entry of (r?.stdout ?? "").split("\0")) {
    const [a, d, ...rest] = entry.split("\t");
    if (!rest.length) continue;
    const path = rest.join("\t"), old = map[path] ?? { add: 0, del: 0 };
    map[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return map;
}

async function scanRepo(root, on) {
  const repo = { root, name: root.split("/").pop() || root, on, staged: [], unstaged: [], branch: "", ahead: null, behind: null, error: null };
  const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on })
    .catch((e) => ({ code: -1, stderr: String(e) }));
  if (st.code !== 0) { repo.error = (st.stderr || "git status 失败").trim().slice(0, 120); return repo; }
  const { staged, unstaged } = parseStatus(st.stdout);
  const [cachedStats, workStats, branch, track] = await Promise.all([
    numstat(root, on, true),
    numstat(root, on, false),
    git(root, on, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null),
    git(root, on, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]).catch(() => null),
  ]);
  repo.branch = branch?.code === 0 ? branch.stdout.trim() : "";
  if (track?.code === 0) {
    const [behind, ahead] = track.stdout.trim().split(/\s+/).map(Number);
    repo.behind = behind ?? 0; repo.ahead = ahead ?? 0;
  }
  repo.staged = staged.map((f) => ({ ...f, ...(cachedStats[f.path] ?? { add: 0, del: 0 }) }));
  repo.unstaged = unstaged.map((f) => ({ ...f, ...(workStats[f.path] ?? { add: 0, del: 0 }) }));
  return repo;
}

// 泳道配色与间距（VS Code Git Graph: grid.x=24, grid.y=32）
const LANE = ["#4fbf6b", "#e2b45c", "#8fb1ec", "#b48ce0", "#63c7c0", "#e2574c"];
const LANE_W = 18;
const ROW_H = 28;
const NULL_ID = -1;

// ── 完整移植 VS Code Git Graph 的布局算法 ──
// Vertex 是一个提交（id = 行号，x = 列），Branch 是一条连续路径，
// 每条 Branch 有自己的颜色，整条线同色。
class GVertex {
  constructor(id) {
    this.id = id;
    this.x = 0;
    this.parents = [];
    this.children = [];
    this.nextParent = 0;
    this.onBranch = null;
    this.nextX = 0;          // 本行下一个可用列
    this.connections = [];   // 每列登记的「连到谁 / 属于哪条分支」
  }
  getNextParent() { return this.nextParent < this.parents.length ? this.parents[this.nextParent] : null; }
  registerParentProcessed() { this.nextParent++; }
  isMerge() { return this.parents.length > 1; }
  addToBranch(branch, x) { if (this.onBranch === null) { this.onBranch = branch; this.x = x; } }
  isNotOnBranch() { return this.onBranch === null; }
  isOnThisBranch(b) { return this.onBranch === b; }
  getPoint() { return { x: this.x, y: this.id }; }
  getNextPoint() { return { x: this.nextX, y: this.id }; }
  // 查「有没有已经连到同一个父、同一条分支的点」，有就复用那列，不再新开
  getPointConnectingTo(vertex, onBranch) {
    for (let i = 0; i < this.connections.length; i++) {
      const c = this.connections[i];
      if (c && c.connectsTo === vertex && c.onBranch === onBranch) return { x: i, y: this.id };
    }
    return null;
  }
  registerUnavailablePoint(x, connectsTo, onBranch) {
    if (x === this.nextX) { this.nextX = x + 1; this.connections[x] = { connectsTo, onBranch }; }
  }
  getColour() { return this.onBranch !== null ? this.onBranch.getColour() : 0; }
}

class GBranch {
  constructor(colour) { this.colour = colour; this.lines = []; this.end = 0; }
  addLine(p1, p2, lockedFirst) { this.lines.push({ p1, p2, lockedFirst }); }
  setEnd(i) { this.end = i; }
  getColour() { return this.colour; }
}

function buildGraph(commits) {
  const n = commits.length;
  const lookup = new Map();
  commits.forEach((c, i) => lookup.set(c.hash, i));
  const vertices = commits.map((_, i) => new GVertex(i));
  const nullVertex = new GVertex(NULL_ID);
  for (let i = 0; i < n; i++) {
    for (const ph of commits[i].parents ?? []) {
      const pi = lookup.get(ph);
      if (pi !== undefined) {
        vertices[i].parents.push(vertices[pi]);
        vertices[pi].children.push(vertices[i]);
      } else {
        vertices[i].parents.push(nullVertex);
      }
    }
  }

  const branches = [];
  const availableColours = [];
  const getAvailableColour = (startAt) => {
    for (let i = 0; i < availableColours.length; i++) if (startAt > availableColours[i]) return i;
    availableColours.push(0);
    return availableColours.length - 1;
  };

  // 一条路径：从 startAt 出发沿父链走，直到父已在别的分支上
  const determinePath = (startAt) => {
    let i = startAt;
    let vertex = vertices[i];
    let parentVertex = vertex.getNextParent();
    let curVertex, curPoint;
    let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();

    if (parentVertex !== null && parentVertex.id !== NULL_ID && vertex.isMerge()
        && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
      // merge 连到两个已经在分支上的顶点：沿路找有没有现成的连接点
      let found = false;
      const parentBranch = parentVertex.onBranch;
      for (i = startAt + 1; i < n; i++) {
        curVertex = vertices[i];
        curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch);
        if (curPoint !== null) found = true;
        else curPoint = curVertex.getNextPoint();
        parentBranch.addLine(lastPoint, curPoint,
          !found && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true);
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
        lastPoint = curPoint;
        if (found) { vertex.registerParentProcessed(); break; }
      }
      return;
    }

    const branch = new GBranch(getAvailableColour(startAt));
    vertex.addToBranch(branch, lastPoint.x);
    vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);
    for (i = startAt + 1; i < n; i++) {
      curVertex = vertices[i];
      curPoint = (parentVertex === curVertex && !parentVertex.isNotOnBranch())
        ? curVertex.getPoint()
        : curVertex.getNextPoint();
      branch.addLine(lastPoint, curPoint, lastPoint.x < curPoint.x);
      curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
      lastPoint = curPoint;
      if (parentVertex === curVertex) {
        vertex.registerParentProcessed();
        const parentOnBranch = !parentVertex.isNotOnBranch();
        parentVertex.addToBranch(branch, curPoint.x);
        vertex = parentVertex;
        parentVertex = vertex.getNextParent();
        if (parentVertex === null || parentOnBranch) break;
      }
    }
    if (i === n && parentVertex !== null && parentVertex.id === NULL_ID) vertex.registerParentProcessed();
    branch.setEnd(i);
    branches.push(branch);
    // 关键：记下这条颜色用到第几行结束，下次分配颜色时才知道能不能复用
    availableColours[branch.getColour()] = i;
  };

  let i = 0;
  while (i < n) {
    if (vertices[i].getNextParent() !== null || vertices[i].isNotOnBranch()) determinePath(i);
    else i++;
  }
  return { vertices, branches };
}

async function scanLog(root, on) {
  const r = await git(root, on, ["log", "--date-order", "--parents", `-n${LOG_LIMIT}`,
    "--pretty=format:%h%x1f%p%x1f%s%x1f%ct%x1f%D%x1f%an"]).catch(() => null);
  if (r?.code !== 0) return [];
  const commits = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [hash, parents, subject, ts, refs, author] = line.split("\x1f");
    if (!hash) continue;
    const names = (refs || "").split(",").map((x) => x.trim()).filter(Boolean);
    const branch = names.find((n) => !n.startsWith("tag:") && !n.includes("HEAD")) ?? "";
    // %h 的缩写长度跟仓库规模变（可能 8 位），统一截成 7 位，才能和 %p 里的父 hash 对上。
    commits.push({
      hash: hash.slice(0, 7), subject, when: relTime(ts), author: author || "",
      parents: (parents || "").split(" ").filter(Boolean).map((x) => x.slice(0, 7)),
      branch: branch.replace("-> ", "").trim(),
      head: names.some((n) => n.includes("HEAD")),
    });
  }
  return { commits, graph: buildGraph(commits) };
}

async function scanBranches(root, on) {
  const r = await git(root, on, ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(HEAD)"]).catch(() => null);
  if (r?.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, head] = line.split("\t");
    return { name, current: head === "*" };
  });
}

// 一个文件的改动行：未跟踪/新增直接读文件画成 +，其余走 git diff。面板和弹窗共用。
async function loadDiff(root, on, path, staged, fresh) {
  if (fresh) {
    const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
    if (text === null) return ["无法预览这个文件（二进制、太大或读不到）"];
    if (text.includes("\0")) return ["二进制文件 · 没有文本 diff"];
    return [`@@ -0,0 +1,${countLines(text)} @@`,
      ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
  }
  const r = await git(root, on, ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path]);
  if (r.code !== 0) throw new Error(r.stderr);
  const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  return first < 0 ? ["没有文本 diff"] : all.slice(first);
}

// 统一的图标按钮：28×28，chrome 底，hover 变色；主操作用 solid 底。
function iconButton(id, t, { name, on = true, primary = false, ghost = false, tip, fn }) {
  const fg = primary ? (on ? t.solid_foreground : t.dim) : on ? t.muted : t.dim;
  const bgc = primary ? (on ? t.solid : t.raised) : ghost ? t.background : t.chrome;
  const box = ghost ? 24 : 28;
  return h_flex().id(id).size(box).flex_none().items_center().justify_center().rounded(6).bg(bgc)
    .when(on, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)))
    .on_click((_e, cx) => { if (on) fn(cx); })
    .tooltip(tip)
    .child(ICONS(name, fg, ghost ? 15 : 14));
}

// 弹窗里的 diff：标题栏 + 行号 + 横向滚动，虚拟列表只画可见行。
class DiffViewer {
  init(_p, cx) {
    this.p = props() ?? {};
    this.rows = []; this.longest = 0; this.gutterChars = 4;
    this.loading = true; this.error = null;
    const { root, on, path, staged, fresh } = this.p;
    cx.spawn(async (cx) => {
      try {
        const lines = await loadDiff(root, on, path, staged, fresh);
        this.rows = diffRows(lines.slice(0, 1500).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "…" : l)));
        this.longest = Math.max(0, ...this.rows.map((r) => displayColumns(r.text)));
        this.gutterChars = Math.max(4, String(Math.max(0, ...this.rows.map((r) => r.number ?? 0))).length);
      } catch (e) {
        this.error = String(e).slice(0, 120);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  gutter(size) { return Math.ceil(this.gutterChars * charWidth(size)) + 2; }

  row({ kind, number, text }, t, size) {
    const h = rowHeight(size);
    if (kind === "@") return div().w_full().px(12).h(h).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(h).flex_none().gap(10)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18"))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(this.gutter(size)).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    const t = theme(), size = settings().font_size;
    const path = this.p.path ?? "";
    const name = path.split("/").pop() || path;
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(path))
        .child(div().flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(this.p.fresh ? "新文件" : this.p.staged ? "已暂存" : "未暂存"))
        .child(iconButton("diff-close", t, { name: "close", tip: "关闭", fn: () => closeOverlay(this.p.overlay) })))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(size)
        .child(div().id("diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(Math.max(320, this.longest * charWidth(size) + this.gutter(size) + 20)).h_full()
            .child(v_virtual_list("diff-rows", this.rows.length, rowHeight(size), (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row) => this.row(row, t, size))).size_full())))
        .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, (e) => e.child(div().absolute().top(10).px(12).text_size(11).text_color(t.dim)
          .child(this.loading ? "读取中…" : this.error || "没有内容"))));
  }
}

class ChangesPanel extends View {
  init(_props, cx) {
    this.repos = [];
    // 每个工作目录各记自己上次选的仓库；高度是全局的。
    this.currentRoot = null;   // refresh 里按当前目录取
    this.message = "";
    this.log = []; this.branches = [];
    this.picker = null;
    this.gitH = shared("changes.gitH") ?? null;   // 拖过的高度；null = 默认 12 条
    this.dragging = false;
    this.confirmDiscard = null;
    this.note = null;
    this.loading = false; this.busy = false;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "提交信息" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(600, (cx) => this.refreshIfDue(cx));
  }

  get repo() { return this.repos.find((r) => r.root === this.currentRoot) ?? null; }

  get files() {
    const repo = this.repo;
    if (!repo) return [];
    return [
      ...repo.staged.map((f) => ({ ...f, staged: true })),
      ...repo.unstaged.map((f) => ({ ...f, staged: false })),
    ];
  }

  refreshIfDue(cx) {
    const active = winInfo()?.active !== false;
    if (!active || this.loading || this.busy) return;
    if (Date.now() >= (this.pollAt ?? 0)) this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), next = key();
    if (next !== this.contextKey) {
      this.repoKey = `changes.repo.${cwd ?? ""}`;
      this.currentRoot = shared(this.repoKey) ?? null;
      this.contextKey = next;
      this.repos = [];
      this.log = []; this.branches = []; this.picker = null; this.confirmDiscard = null;
    }
    this.pollAt = Date.now() + (on ? POLL_REMOTE : POLL_LOCAL);
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const roots = await discoverRepos(cwd, on);
        const scanned = [];
        for (const root of roots) scanned.push(await scanRepo(root, on));
        if (this.contextKey !== next) return;
        this.repos = scanned;
        // 记住的仓库还在这个目录里就用它，否则退回第一个（记忆不清，换回来还在）。
        if (!scanned.some((r) => r.root === this.currentRoot)) {
          this.currentRoot = scanned[0]?.root ?? null;
        }
        await this.loadCurrent();
      } catch (e) {
        if (this.contextKey === next) this.note = String(e).slice(0, 140);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async loadCurrent() {
    const repo = this.repo;
    if (!repo) { this.log = []; this.branches = []; return; }
    const [log, branches] = await Promise.all([scanLog(repo.root, repo.on), scanBranches(repo.root, repo.on)]);
    this.log = log?.commits ?? [];
    this.graph = log?.graph ?? null;
    this.branches = branches;
  }

  // 一次 git 写操作：跑完下一轮轮询自然会重扫，失败就把 git 的原话显示出来。
  run(cx, args, done) {
    const repo = this.repo;
    if (!repo || this.busy) return;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: repo.root, on: repo.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        done?.();
      } catch (e) {
        this.note = `${args[0]} 失败：${String(e).slice(0, 110)}`;
      } finally {
        this.busy = false;
        this.pollAt = 0;
        cx.notify();
      }
    });
    cx.notify();
  }

  stage(path, cx) { this.run(cx, ["add", "--", path]); }
  // 全部暂存 / 全部取消暂存：一条命令搞定，不逐个文件跑。
  stageAll(cx) { this.run(cx, ["add", "-A"]); }
  unstageAll(cx) { this.run(cx, ["reset"]); }
  unstage(path, cx) { this.run(cx, ["restore", "--staged", "--", path]); }

  // 丢弃：点一次变红「确定?」，再点才执行；未跟踪的新文件不给，那等于删文件。
  discard(path, cx) {
    if (this.confirmDiscard !== path) { this.confirmDiscard = path; cx.notify(); return; }
    this.confirmDiscard = null;
    this.run(cx, ["restore", "--worktree", "--", path]);
  }

  commit(cx) {
    const repo = this.repo, message = this.message.trim();
    if (!repo) return;
    if (!repo.staged.length) { this.note = "没有已暂存的改动，先点 + 暂存"; cx.notify(); return; }
    if (!message) { this.note = "提交信息不能为空"; cx.notify(); return; }
    this.run(cx, ["commit", "-m", message], () => {
      this.message = "";
      this.input.set_value?.("");
    });
  }

  pull(cx) { this.run(cx, ["pull", "--ff-only"]); }

  push(cx) {
    const repo = this.repo;
    if (!repo) return;
    this.run(cx, repo.ahead === null ? ["push", "-u", "origin", "HEAD"] : ["push"]);
  }

  switchBranch(name, cx) {
    this.picker = null;
    if (this.repo?.branch === name) { cx.notify(); return; }
    // git switch 会改仓库 HEAD，下一轮扫描自然读到新分支；失败时 run 会显示 git 原话。
    this.run(cx, ["switch", name], () => {
      if (this.repo) this.repo.branch = name;   // 立刻反映到界面，不等下一轮
    });
  }

  switchRepo(root, cx) {
    this.picker = null;
    if (this.currentRoot === root) { cx.notify(); return; }
    this.currentRoot = root;
    if (this.repoKey) setShared(this.repoKey, root);
    cx.notify();
    cx.spawn(async (cx) => { await this.loadCurrent(); cx.notify(); });
  }

  // 点文件：不在面板里挤，弹一个窗看 diff。
  openDiff(f) {
    const repo = this.repo;
    if (!repo) return;
    openOverlay({
      mod: "changes-mine",
      kind: "dialog",
      width: 0.85,
      height: 0.85,
      props: { part: "diff", root: repo.root, on: repo.on, path: f.path, staged: f.staged, fresh: Boolean(f.fresh) },
    });
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    // 目录只留最后两级并前置省略号：mods/abs/parts/ -> …/abs/parts/
    // 原来整条路径靠 truncate 从尾部砍，窄面板里变成 mo... 完全看不出是哪。
    const tail = parts.slice(-2);
    const dir = parts.length ? `${parts.length > 2 ? "…/" : ""}${tail.join("/")}/` : "";
    const confirming = this.confirmDiscard === f.path;
    const mini = (id, glyph, tone, tip, fn) =>
      h_flex().id(id).size(20).flex_none().items_center().justify_center().rounded(5)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
        .tooltip(tip)
        .child(ICONS(glyph, tone, 12));
    return h_flex().id(`f-${f.staged ? "s" : "u"}-${f.path}`).h(26).flex_none().px(6).gap(6).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => this.openDiff(f))
      .child(div().w(10).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      // 文件名优先完整；目录可压缩，两者合起来占满左侧剩余宽度。
      .child(div().flex_none().max_w(150).truncate().child(name))
      .when(Boolean(dir), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(dir)))
      .child(div().flex_none().w(2))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi1).child(`−${f.del}`)))
      .when(!f.staged && !f.fresh, (e) => e.child(confirming
        ? h_flex().id(`d-${f.path}`).h(20).px(6).flex_none().items_center().rounded(5).bg(t.ansi1).cursor_pointer()
            .on_click((_e, cx) => { cx.stop_propagation(); this.discard(f.path, cx); })
            .child(div().text_size(10).text_color(t.solid_foreground).child("确定?"))
        : mini(`d-${f.path}`, "undo", t.dim, "丢弃改动", (cx) => this.discard(f.path, cx))))
      .child(mini(`t-${f.path}`, f.staged ? "minus" : "plus", f.staged ? t.dim : t.ansi2,
        f.staged ? "取消暂存" : "暂存",
        (cx) => (f.staged ? this.unstage(f.path, cx) : this.stage(f.path, cx))));
  }

  // bulk: { icon, tip, fn } —— 分段标题右侧的批量操作（全部暂存 / 全部取消暂存）
  section(title, list, t, bulk = null) {
    if (!list.length) return [];
    const add = list.reduce((n, f) => n + (f.add || 0), 0), del = list.reduce((n, f) => n + (f.del || 0), 0);
    return [
      h_flex().w_full().flex_none().h(26).px(6).gap(6).items_center()
        .child(div().flex_none().text_size(11).font_medium().text_color(t.muted).child(title))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(String(list.length)))
        .child(div().flex_1())
        .when(add > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi1).child(`−${del}`)))
        .when(Boolean(bulk), (e) => e.child(
          h_flex().id(`bulk-${title}`).size(20).flex_none().items_center().justify_center().rounded(5)
            .cursor_pointer().hover((x) => x.bg(t.hover))
            .tooltip(bulk.tip)
            .on_click((_e, cx) => { cx.stop_propagation(); bulk.fn(cx); })
            .child(ICONS(bulk.icon, bulk.icon === "plus" ? t.ansi2 : t.dim, 12)))),
      ...list.map((f) => this.fileRow(f, t)),
    ];
  }

  render(cx) {
    if (key() !== this.contextKey) this.refresh(cx);
    else this.refreshIfDue(cx);
    const t = theme();
    const repo = this.repo, files = this.files;
    const staged = files.filter((f) => f.staged), unstaged = files.filter((f) => !f.staged);
    const add = files.reduce((n, f) => n + (f.add || 0), 0), del = files.reduce((n, f) => n + (f.del || 0), 0);
    const canCommit = Boolean(this.message.trim() && repo?.staged.length && !this.busy && !this.loading);
    const tracking = repo && repo.ahead != null ? `↑${repo.ahead}↓${repo.behind}` : "";

    // 下拉按钮：宽度随内容但可被压缩，文字截断，箭头永远在（不会挤出面板）
    const pill = (id, text, active, fn, shrink = true) =>
      h_flex().id(id).h(22).px(6).min_w(0).items_center().gap(3).rounded(5)
        .when(shrink, (e) => e.flex_shrink(1), (e) => e.flex_none())
        .bg(active ? t.selected : t.chrome).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => fn(cx))
        .child(shrink
          ? div().min_w(0).truncate().text_size(10).text_color(t.muted).child(text)
          : div().flex_none().text_size(10).text_color(t.muted).child(text))
        .child(div().flex_none().text_size(7).text_color(t.dim).child("▾"));

    const pickerRow = (kind, items, onPick) =>
      items.length
        ? items.slice(0, 20).map((it, i) =>
            h_flex().id(`pick-${kind}-${i}`).h(24).flex_none().px(8).gap(6).items_center().rounded(5)
              .cursor_pointer().hover((x) => x.bg(t.hover))
              .when(it.active, (e) => e.bg(t.selected))
              .on_click((_e, cx) => onPick(it, cx))
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(it.active ? t.foreground : t.muted).child(it.label))
              .when(it.active, (e) => e.child(div().text_size(10).text_color(t.ansi2).child("✓"))))
        : [div().px(8).py(6).text_size(11).text_color(t.dim).child("空")];

    // 历史区的行：要么是仓库/分支选项，要么是提交列表。摊平成数组，避免深嵌套括号。
    const historyRows = [];
    if (this.picker === "repo") {
      historyRows.push(...pickerRow("repo",
        this.repos.map((r) => ({ key: r.root, label: r.name, active: r.root === repo?.root })),
        (it, cx) => this.switchRepo(it.key, cx)));
    } else if (this.picker === "branch") {
      historyRows.push(...pickerRow("branch",
        this.branches.map((b) => ({ key: b.name, label: b.name, active: b.current })),
        (it, cx) => this.switchBranch(it.key, cx)));
    } else if (this.log.length === 0) {
      historyRows.push(div().p(8).text_size(11).text_color(t.dim).child("还没有提交历史"));
    } else {
      // 按 VS Code 的模型渲染：每条 branch 一条同色路径，节点颜色跟它所属的分支。
      const graph = this.graph;
      const verts = graph?.vertices ?? [];
      const lanes = Math.max(1, ...verts.map((v) => v.nextX));
      const xOf = (col) => 8 + col * LANE_W;
      const yOf = (row) => row * ROW_H + ROW_H / 2;
      const colourOfColour = (c) => LANE[(c ?? 0) % LANE.length];
      const D = ROW_H * 0.8;
      const paths = [];
      for (const br of (graph?.branches ?? [])) {
        const color = colourOfColour(br.colour);
        for (const ln of br.lines) {
          const x1 = xOf(ln.p1.x), y1 = yOf(ln.p1.y), x2 = xOf(ln.p2.x), y2 = yOf(ln.p2.y);
          if (x1 === x2) {
            if (Math.abs(y2 - y1) < 0.5) continue;
            paths.push({ path: PathBuilder.stroke(1.6).move_to(x1, y1).line_to(x2, y2).build(), color });
          } else {
            paths.push({ path: PathBuilder.stroke(1.6)
              .move_to(x1, y1)
              .cubic_bezier_to(x2, y2, x1, y1 + D, x2, y2 - D)
              .build(), color });
          }
        }
      }
      const canvas = div().absolute().left(0).top(0).w(lanes * LANE_W + 12).h(verts.length * ROW_H)
        .when(!this.dragging, (e) => e.children(paths.map((p) => window.paint_path(p.path, p.color))));

      // 文字让开「本行实际用到的列」：单分支时紧跟圆点，有分支穿过才右移。
      const textLeft = (i) => xOf(Math.max(verts[i]?.nextX ?? 1, 1) - 1) + 10;

      const lines = this.log.map((c, i) => {
        const v = verts[i];
        const color = colourOfColour(v?.getColour?.() ?? 0);
        const dot = c.head
          ? div().size(9).rounded(5).border_2().border_color(color).bg(t.background)
          : div().size(8).rounded(4).bg(color);
        const size = c.head ? 9 : 8;
        return h_flex().w_full().flex_none().h(ROW_H).items_center().relative()
          .cursor_pointer()
          .tooltip(`${c.hash} · ${c.when}`)
          .child(div().absolute().left(xOf(v?.x ?? 0) - size / 2).top(ROW_H / 2 - size / 2).child(dot))
          .child(div().w(textLeft(i)).flex_none())
          .child(h_flex().flex_1().min_w(0).gap(6).items_center()
            .child(div().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(c.subject || "(无标题)"))
            .when(Boolean(c.author), (x) => x.child(div().flex_none().max_w(56).truncate()
              .text_size(10).text_color(t.dim).child(c.author))))
          .when(Boolean(c.branch) && c.head, (x) => x.child(div().flex_none().pl(4).max_w(72).truncate()
            .text_size(9.5).text_color(color).child(c.branch)))
          .child(div().w(56).flex_none().truncate().text_right().text_size(9.5).text_color(t.dim).child(c.when));
      });

      historyRows.push(div().relative().w_full().h(verts.length * ROW_H)
        .child(canvas)
        .child(v_flex().w_full().children(lines)));
    }

    // 拖动中铺一层透明捕获层：拖动条会跟着 Git 区移动，只有覆盖整块才能持续收到 move。
    const dragCatcher = this.dragging
      ? div().id("git-drag-catch").absolute().inset_0().cursor_row_resize()
          .on_mouse_move((e, cx) => {
            if (e.pressed_button !== "left") { this.dragging = false; cx.notify(); return; }
            const dy = this.dragY - e.position.y;      // 往上拖为正 -> 变高
            const next = Math.max(90, Math.min(900, this.dragH + dy));
            if (Math.abs(next - (this.gitH ?? 0)) < 2) return;   // 抖动不到 2px 不重绘
            this.gitH = next;
            // 节流：整块面板重绘一次很贵，拖动时最多每 40ms 刷一次。
            const now = Date.now();
            if (now - (this.dragPaint ?? 0) < 40) return;
            this.dragPaint = now;
            cx.notify();
          })
          .on_mouse_up("left", (_e, cx) => {
            this.dragging = false;
            if (this.gitH != null) setShared("changes.gitH", Math.round(this.gitH));
            cx.notify();
          })
      : null;

    return v_flex().id("changes-mine").size_full().min_h(0).w_full().relative().rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      // 头部：标题 + 仓库名（可截断）+ 增删 + 刷新
      .child(h_flex().h(34).flex_none().w_full().pl(10).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(12.5).font_semibold().child("Changes"))
        .when(Boolean(tracking), (e) => e.child(div().flex_none().text_size(11).text_color("#8fb1ec").child(tracking)))
        .child(div().flex_1().min_w(4))
        .child(iconButton("pull", t, { name: "arrow-down", ghost: true, on: Boolean(repo) && !this.busy, tip: "拉取", fn: (cx) => this.pull(cx) }))
        .child(iconButton("push", t, { name: "arrow-up", ghost: true, on: Boolean(repo) && !this.busy, tip: "推送", fn: (cx) => this.push(cx) })))
      // 提交：AI 生成和提交两个按钮都内嵌在输入框右端
      .child(div().flex_none().w_full()
        .child(div().relative().w_full().h(38)
          .child(div().id("commit-message").w_full().h_full().pl(10).pr(34).flex().items_center()
            .border_b(1).border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().id("commit").absolute().right(6).top(7).size(24)
            .items_center().justify_center().rounded(5)
            .bg(canCommit ? t.solid : t.raised)
            .when(canCommit, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)))
            .on_click((_e, cx) => { if (canCommit) this.commit(cx); })
            .tooltip("提交已暂存的改动")
            .child(ICONS("check", canCommit ? t.solid_foreground : t.dim, 13)))))
      // 文件：已暂存 / 已更改。有改动才撑高，没改动缩成一行，把空间让给历史。
      .child(div().flex_grow(1).flex_basis(0).min_h(36).w_full().relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-files").absolute().inset_0().overflow_y_scroll().px(6).py(4)
          .children([
            ...this.section("已暂存", staged, t, { icon: "minus", tip: "全部取消暂存", fn: (cx) => this.unstageAll(cx) }),
            ...this.section("已更改", unstaged, t, { icon: "plus", tip: "全部暂存", fn: (cx) => this.stageAll(cx) }),
          ])
          .when(!files.length, (e) => e.child(div().p(8).text_size(11).text_color(t.dim)
            .child(this.loading ? "扫描中…" : repo?.error || (this.repos.length ? "没有未提交的改动" : "这个目录下没有 git 仓库")))))
        .child(Scrollbar.vertical("changes-files").absolute().inset_0()))
      .when(Boolean(this.note), (e) => e.child(div().w_full().px(10).pb(4).text_size(10.5).text_color(t.ansi1).child(this.note)))
      // 历史：按剩余空间伸缩（最小 120），不再写死高度；标题行带仓库/分支切换
      .child(v_flex().flex_none().h(this.gitH ?? Math.min(this.log.length || 1, 12) * ROW_H + 42).w_full()
        // 拖动条：按住上下拖就改 Git 区高度（往上拖变高）。
        .child(div().id("git-resize").w_full().h(6).flex_none().cursor_row_resize()
          .bg(this.dragging ? t.accent : t.background)
          .hover((x) => x.bg(t.hover))
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.dragging = true;
            this.dragY = e.position.y;
            this.dragH = this.gitH ?? Math.min(this.log.length || 1, 12) * ROW_H + 42;
            cx.notify();
          }))
        .child(h_flex().h(34).flex_none().w_full().pl(10).pr(8).gap(6).items_center().border_b(1).border_color(t.border)
          .child(ICONS("history", t.muted, 14))
          .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child("Git"))
          .child(div().flex_1().min_w(4))
          .child(pill("repo-picker", repo?.name ?? "无仓库", this.picker === "repo", (cx) => { this.picker = this.picker === "repo" ? null : "repo"; cx.notify(); }))
          .child(pill("branch-picker", repo?.branch || "—", this.picker === "branch", (cx) => { this.picker = this.picker === "branch" ? null : "branch"; cx.notify(); }, false)))
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id("changes-history").absolute().inset_0().overflow_y_scroll().px(6).py(4).children(historyRows))
          .child(Scrollbar.vertical("changes-history").absolute().inset_0())))
      .when(Boolean(dragCatcher), (e) => e.child(dragCatcher))
  }
}

// 一个 mod 两副面孔：布局里是面板，弹窗里是 diff。
export default class ChangesMine extends View {
  init(_p, cx) {
    if (props()?.part === "diff") {
      this.viewer = new DiffViewer();
      this.viewer.init(_p, cx);
    } else {
      this.panel = new ChangesPanel();
      this.panel.init(_p, cx);
    }
  }

  render(cx) {
    return this.viewer ? this.viewer.render(cx) : this.panel.render(cx);
  }
}
