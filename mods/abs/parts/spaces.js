// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";
import { SPACE_ICONS } from "./space-icons.js";

// 每个空间正在跑的 agent。一次遍历分组，行渲染时按 id 取。
function agentMap() {
  const m = new Map();
  for (const a of agents() || []) {
    if (!a.app) continue;
    const list = m.get(a.space) ?? [];
    list.push(a);
    m.set(a.space, list);
  }
  return m;
}
const appsOf = (w, map) => (map ?? agentMap()).get(w.id) ?? [];

// 名字只留前 10 个字母，多的收成省略号：侧栏窄，名字一长圆圈和行尾 git 就没地方站。
const name10 = (n) => (n.length > 10 ? `${n.slice(0, 10)}\u2026` : n);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps, path) => JSON.stringify([s.machine ?? null, path ?? place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
// A space's icon: one of a few single-colour glyphs, picked by its id so it
// stays the same between starts. Not the per-space colours of `space.colors`
// (those still drive nothing here; drop this when they should).
// A picked one (the space's context menu, "Change icon") wins; else by id.
const spaceIcon = (id) => {
  const picked = (shared("space.icons") ?? {})[id];
  if (picked) return picked;
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return SPACE_ICONS[h % SPACE_ICONS.length];
};

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.wasStatus = {}; // address -> 上一次见到的 status
    this.fresh = {}; // address -> true：刚干完活、还没点开看（圆圈显蓝）
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // agent 的状态变了（working/done/blocked）就重画一次。只在真的变了才 notify，
    // 闲着时不打扰。spins 的动画自己走，不需要这里驱动。
    this.agentKey = this.agentStates();
    cx.timer.every(1000, (cx) => {
      this.trackAgents();
      const now = this.agentStates();
      if (now === this.agentKey) return;
      this.agentKey = now;
      cx.notify();
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    const ps = panes();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    // 每 15 秒扫一次：已经不存在的空间 / agent / pane 留下的缓存条目没人再读，删掉，
    // 否则它们只增不减（换个目录就多一条）。
    if (now - (this.swept ?? 0) > 15000) {
      this.swept = now;
      this.sweep(sp, ps);
    }
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // 只留还活着的键。删掉 git 的条目只是让下次重查一遍，不丢数据。
  sweep(sp, ps) {
    const spaceIds = new Set(sp.map((s) => s.id));
    const places = new Set(sp.map((s) => where(s, ps)));
    const live = new Set((agents() ?? []).map((a) => a.address));
    const paneIds = new Set(ps.map((p) => p.pane));
    for (const id of Object.keys(this.born)) if (!spaceIds.has(id)) delete this.born[id];
    for (const id of [...this.shown]) if (!spaceIds.has(id)) this.shown.delete(id);
    for (const k of Object.keys(this.at)) if (!spaceIds.has(k)) delete this.at[k];
    for (const k of Object.keys(this.git)) if (!places.has(k)) delete this.git[k];
    for (const k of Object.keys(this.checked)) if (!places.has(k)) delete this.checked[k];
    for (const k of [...this.unsure]) if (!places.has(k)) this.unsure.delete(k);
    for (const k of Object.keys(this.wasStatus)) if (!live.has(k)) delete this.wasStatus[k];
    for (const k of Object.keys(this.fresh)) if (!live.has(k)) delete this.fresh[k];
    for (const k of Object.keys(this.busy)) if (!paneIds.has(k)) delete this.busy[k];
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    // 这个函数每 250ms 跑一次：where 的键还是字符串（要做 Set 键），但不再为了取
    // 第二个字段而 JSON.parse 一遍 —— place() 只算一次，顺手用。
    const at = {};
    const keys = new Set();
    for (const s of sp) {
      const path = place(s, ps);
      at[s.id] = where(s, ps, path);
      if (path) keys.add(at[s.id]);
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "abs", kind: "popup", width: 200, height: 260, props: { part: "menu", tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => {
      if (this.shown.has(w.id)) return true;
      if (where(w, ps) in this.git) return true;
      // 1.5 秒还没等到 git 结果也放行，否则一个卡住的机器会让整块列表停在 Loading。
      // born 只在第一次见到时记，后面不再刷新，否则永远到不了 1.5 秒。
      if (this.born[w.id] === undefined) this.born[w.id] = Date.now();
      return Date.now() - this.born[w.id] > 1500;
    };
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/abs/icons/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/abs/icons/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/abs/icons/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const where = branch;
    return h_flex()
      .min_w(0)
      .flex_grow(0)
      .flex_shrink(1)
      .gap(5)
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).max_w(64).flex_shrink(8).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // 一个工作区里正在跑的 agent：一个 app 一个圆圈，圆里放它的图标。
  // 一个工作区里正在跑的 agent：一个 agent 一个圆圈，圆里是它的图标。
  // 状态按 agents() 的 status 画，跟左侧 Agents 列表同一套语言：
  //   working 转圈 / blocked 蓝色带 ! / done 蓝色圆点 / idle 只剩图标
  // 所有 agent 的状态拼成一个串，用来判断要不要重画。
  agentStates() {
    return (agents() || []).map((a) => `${a.address}:${a.status}`).join(",");
  }

  // core 的 done 一亮就被「看过」转成 idle，所以自己记住：干完活的 agent 留一个蓝圈
  // 直到点开看。又开工（working/blocked）就清掉。
  trackAgents() {
    for (const a of agents() || []) {
      const prev = this.wasStatus[a.address];
      const st = a.status;
      // 只在状态真的变了时动 fresh：core 会一直报 done，否则你点掉之后下一秒又亮回来。
      if (st !== prev) {
        if (st === "done" || (prev === "working" && st === "idle")) this.fresh[a.address] = true;
        else if (st === "working" || st === "blocked") this.fresh[a.address] = false;
      }
      this.wasStatus[a.address] = st;
    }
  }

  agentDots(t, list) {
    const MOST = 6; // 一行最多画几个圆，多的折成 +N
    const n = Math.min(list.length, MOST);
    const wpx = 18 + (n - 1) * 10;
    const items = list.slice(0, MOST);
    // working 的转圈弧：单独一层，而且排在所有圆圈**之前**。
    // gpui 没有 z-index，层级只由先后顺序决定（后画的在上面）：弧排在前面，于是
    // 每个圆圈都盖在弧上面 —— 弧永远盖不到任何图标，也不会被自己的圆裁掉（它本来
    // 就在圆外面）。ring-spin.svg 半径 9.6、线宽 1.5 → 可见的那圈正好紧贴边框外沿。
    const spins = items
      .map((a, i) =>
        a.status === "working"
          ? svg("mods/abs/icons/ring-spin.svg").size(24).absolute().top(-3).left(i * 10 - 3)
              .text_color(t.working).spin(900)
          : null,
      )
      .filter(Boolean);
    return div().relative().flex_none().flex_shrink(0).h(18).w(wpx)
      .children(spins)
      .children(items.map((a, i) => {
        const prog = a.program;
        const name = a.app || "agent";
        const st = a.status;
        // 边框颜色表示状态，和左侧 Agents 列表同一套：done 蓝、blocked 蓝、其余灰。
        // core 的 done 一亮就被「看过」转成 idle，所以用 this.fresh 记住「刚干完还没看」。
        const fresh = Boolean(this.fresh[a.address]);
        const flagged = st === "done" || fresh;
        const wide = st === "blocked" || flagged;
        // working 不画橙边框 —— 由外面那道转圈弧表示在跑（原来就是这么分的），
        // 两个橙圈叠在一起会显得很粗。
        const ring = st === "blocked" ? t.blocked : flagged ? t.done ?? t.ansi4 : t.border;
        const dot = div()
          .absolute().top(0).left(i * 10)
          .size(18).flex_none().rounded(9).flex().items_center().justify_center()
          .bg(prog?.tile ?? t.raised)
          .cursor_pointer()
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.fresh[a.address] = false;
            run("pane.focus", { pane: a.pane });
            cx.notify();
          })
          .tooltip(st ? `${name} · ${st}` : name)
          .child(div().absolute().inset(0).rounded(9)
            .border(wide ? 1.5 : 1).border_color(ring))
          .child(prog?.icon
            ? (prog.tint ? svg(prog.icon).size(12).flex_none().text_color(prog.color ?? t.foreground)
                         : image(prog.icon).w(12).h(12).flex_none())
            : div().text_size(9).text_color(t.foreground).child(name.slice(0, 1)));
        return dot;
      }))
      .when(list.length > MOST, (el) => el.child(div().absolute().top(0).left(wpx + 2).text_size(10).text_color(t.dim).child(`+${list.length - MOST}`)));
  }

  row({ w, i, g, tree }, t) {
    const am = agentMap();
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .pl(16)
      .pr(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) {
          // 点了这一行就算看过它了：行上所有 agent 的「刚干完」蓝圈一起清掉，
          // 不用非得点中那个小圆圈。
          for (const a of appsOf(w, am)) this.fresh[a.address] = false;
          run("space.select", { id: w.id });
        }
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/abs/icons/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(svg(`mods/abs/icons/${spaceIcon(w.id)}.svg`).size(14).flex_none().text_color(t.muted)))
          .child(div().min_w(0).max_w(110).flex_grow(0).flex_shrink(1).truncate().text_size(12.5).text_color(t.foreground).child(name10(w.name)))
          // 圆圈紧跟在名字后面：名字盒子只占文字宽，不用 min_w 撑宽，否则短名字右边
          // 会空一段、把圆圈推远。名字最多 10 个字母，行尾 git 分支另限 64。
          // 圆圈紧跟在名字后面：名字盒子只占文字宽，不用 min_w 撑宽，否则短名字右边
          // 会空一段、把圆圈推远。名字上限 110，行尾 git 分支另限 64；不够时两边一起收。
          .when(appsOf(w, am).length > 0, (el) => el.child(this.agentDots(t, appsOf(w, am))))
          .child(div().flex_1().min_w(0))
          .when(Boolean(g), (el) => el.child(h_flex().min_w(0).flex_grow(0).flex_shrink(1).items_center().child(this.gitTail(g, tree, w.name, t)))),
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).mt(10).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.foreground)
        .when(!collapsed, el => el.child("Spaces"))
        // 侧栏收成 rail 后要有路回来：这个 » 原本长在 agents 模块里，那个模块已经去掉。
        .when(collapsed, el => el.child(
          div().id("spaces-unfold").text_size(13).text_color(t.dim).cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .tooltip("Show sidebar")
            .on_click(() => {
              setShared("sidebar.collapsed", false);
              run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 268 });
            })
            .child("\u00bb"))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
