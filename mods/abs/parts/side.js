// The sidebar, as a desktop agent app draws it: New thread / Search /
// Shortcuts on top, pinned threads, then "Threads": every space is a
// project (a folder you can fold) and every tab in it a thread, with its
// status (spinner while working, "Awaiting approval" when an agent needs
// you, a blue dot when it finished while you weren't looking), its git
// diff (+added -removed) and how long ago it changed. Hover a thread to pin
// or archive it (archive = Herdr's settle: still running, put away).
// The filter switches between By project and Chronological. Settings and
// the light/dark switch sit at the bottom.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, machines, run, theme, shared, setShared, openOverlay, pickFolder, window as win } from "herdr";
import { icon, alpha, own, age, lead, machineOf, diffStat, readAppearance, writeAppearance, installThemes, APPEARANCES } from "./lib.js";

const ROW = 30;

// What a thread is called: its name when someone named it, else what its
// terminal says it is doing (agents set their title), else "Thread 2".
export function threadTitle(tab, leadPane) {
  if (tab.named) return tab.name;
  const title = (leadPane?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return title && title !== leadPane?.program?.name ? title : `Thread ${tab.index}`;
}

export const projectName = (space) => space.name;

// ---- The strip over the sidebar: room for the window buttons, fold. -------
export class SideTop {
  init(cx) {
    cx.spawn(async () => {
      await installThemes();
    });
  }

  render() {
    const t = theme();
    const w = win() ?? {};
    const mac = w.platform === "macos" && !w.fullscreen;
    return h_flex()
      .size_full()
      .pl(mac ? 84 : 14)
      .pr(10)
      .gap(2)
      .items_center()
      .child(div().flex_1())
      .child(
        own(
          div()
            .id("st-open-settings")
            .p(6)
            .rounded(7)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Settings")
            .on_click(() => run("app.settings", {}))
            .child(svg(icon("settings")).size(16)),
        ),
      )
      .child(
        own(
          div()
            .id("st-fold")
            .p(6)
            .rounded(7)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Hide sidebar")
            .on_click(() => run("layout.hide", { id: "sidebar" }))
            .child(svg(icon("panel-left")).size(16)),
        ),
      );
  }
}

// ---- The sidebar itself. --------------------------------------------------
export class Sidebar {
  init(cx) {
    this.hover = null;
    this.filterOpen = false;
    this.showArchived = false;
    this.diffs = {}; // JSON [machine, cwd] -> { add, del } | null
    this.sharing = {}; // JSON [machine, cwd] -> how many open threads are there
    this.appearance = "system";
    cx.spawn(async (cx) => {
      this.appearance = await readAppearance();
      cx.notify();
    });
    this.refresh(cx);
    // Diffs every few seconds; ages twice a minute.
    cx.timer.every(6000, (cx) => this.refresh(cx));
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Git diffs for the folders the listed threads are in, one exec per folder.
  refresh(cx) {
    if (this.refreshing) return;
    const all = panes();
    const folders = new Set();
    for (const s of spaces()) {
      for (const tab of s.tabs) {
        const p = lead(tab.id, all);
        if (p?.cwd) folders.add(JSON.stringify([machineOf(p.terminal) ?? s.machine ?? null, p.cwd]));
      }
    }
    if (!folders.size) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const key of folders) {
        const [on, cwd] = JSON.parse(key);
        const d = await diffStat(cwd, on).catch(() => null);
        const before = this.diffs[key];
        if (JSON.stringify(before) !== JSON.stringify(d)) changed = true;
        this.diffs[key] = d;
      }
      // 已经不在列表里的目录（空间关了、终端 cd 走了）就删掉，别让 diffs 一直长。
      for (const key of Object.keys(this.diffs)) if (!folders.has(key)) delete this.diffs[key];
      this.refreshing = false;
      if (changed) cx.notify();
    });
  }

  pins() {
    return shared("studio.pins") ?? [];
  }

  togglePin(id) {
    const pins = this.pins();
    setShared("studio.pins", pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]);
  }

  collapsed() {
    return shared("studio.collapsed") ?? [];
  }

  toggleProject(id) {
    const c = this.collapsed();
    setShared("studio.collapsed", c.includes(id) ? c.filter((x) => x !== id) : [...c, id]);
  }

  mode() {
    return shared("studio.organize") === "chronological" ? "chronological" : "project";
  }

  // Add project: pick a folder, it becomes a space (a project) with a shell.
  addProject(cx) {
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Add project" }).catch(() => null);
      if (folder) run("space.new", { folder });
    });
  }

  newThread(space) {
    if (space && !space.active) run("space.select", { id: space.id });
    openOverlay({ mod: "new-menu", kind: "popup", width: 280 });
  }

  cycleAppearance(cx) {
    const next = APPEARANCES[(APPEARANCES.indexOf(this.appearance) + 1) % APPEARANCES.length];
    this.appearance = next;
    cx.notify();
    cx.spawn(async (cx) => {
      await writeAppearance(next).catch(() => false);
      this.appearance = await readAppearance();
      cx.notify();
    });
  }

  // A small square button, for the hover actions and headers.
  tool(id, name, tip, onClick, t, size = 15) {
    return div()
      .id(id)
      .flex_none()
      .p(4)
      .rounded(6)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
        cx.notify();
      })
      .child(svg(icon(name)).size(size));
  }

  nav(id, name, label, onClick, t) {
    return h_flex()
      .id(id)
      .mx(8)
      .px(10)
      .h(ROW + 2)
      .gap(10)
      .items_center()
      .rounded(8)
      .text_size(13.5)
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(svg(icon(name)).size(16).text_color(t.muted))
      .child(div().flex_1().truncate().child(label));
  }

  // The 16px slot left of a thread's title: what it's doing.
  status(t, tab, pinnedList) {
    if (tab.status === "working") return svg(icon("spinner")).size(14).text_color(t.working).spin(900);
    if (tab.status === "blocked") return svg(icon("spinner")).size(14).text_color(t.dim);
    if (tab.status === "done") return div().size(7).rounded(4).bg(t.done);
    if (pinnedList) return svg(icon("pin")).size(14).text_color(t.dim);
    return null;
  }

  diff(t, d) {
    if (!d || (!d.add && !d.del)) return null;
    return h_flex()
      .flex_none()
      .gap(4)
      .text_size(12)
      .child(div().text_color(t.ansi2).child(`+${d.add}`))
      .child(div().text_color(t.ansi1).child(`-${d.del}`));
  }

  // A thread's folder, as diffs are keyed.
  folderKey(space, p) {
    return p?.cwd ? JSON.stringify([machineOf(p.terminal) ?? space.machine ?? null, p.cwd]) : null;
  }

  // One thread. `list` keeps ids unique when a thread shows twice (pinned).
  // Its diff shows when the folder is its own (threads sharing a checkout
  // would all repeat one number), or when it's the open thread.
  row(t, space, tab, all, { list, indent, project }) {
    const p = lead(tab.id, all);
    const key = `${list}-${tab.id}`;
    const hovered = this.hover === key;
    const here = space.active && tab.active;
    const pinned = this.pins().includes(tab.id);
    const folder = this.folderKey(space, p);
    const blocked = tab.status === "blocked";
    const d = folder && (here || (this.sharing[folder] ?? 0) <= 1) && !blocked ? this.diffs[folder] : null;
    const actions = tab.settled
      ? h_flex().gap(1).child(this.tool(`st-unarchive-${key}`, "archive-restore", "Unarchive", () => run("tab.unsettle", { id: tab.id }), t, 14))
      : h_flex()
          .gap(1)
          .child(this.tool(`st-pin-${key}`, pinned ? "pin-off" : "pin", pinned ? "Unpin" : "Pin", () => this.togglePin(tab.id), t, 14))
          .child(this.tool(`st-archive-${key}`, "archive", "Archive", () => run("tab.settle", { id: tab.id }), t, 14));
    return h_flex()
      .id(`st-row-${key}`)
      .mx(8)
      .pl(indent ? 10 : 10)
      .pr(8)
      .h(ROW + 2)
      .gap(10)
      .items_center()
      .rounded(8)
      .text_size(13.5)
      .cursor_pointer()
      .when(here, (el) => el.bg(t.selected))
      .when(!here, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((h, cx) => {
        if (h) this.hover = key;
        else if (this.hover === key) this.hover = null;
        cx.notify();
      })
      .on_click(() => (tab.settled ? run("tab.unsettle", { id: tab.id }) : run("tab.select", { id: tab.id })))
      .on_mouse_down("right", () =>
        openOverlay({ mod: "abs", kind: "popup", width: 200, props: { part: "menu", tab: "tab", target: { id: tab.id, space: space.id, settled: tab.settled } } }),
      )
      .child(h_flex().w(16).flex_none().justify_center().child(this.status(t, tab, list === "pinned") ?? div()))
      .child(
        div()
          .flex_1()
          .min_w(56)
          .truncate()
          .text_color(here || tab.status === "done" || tab.status === "blocked" ? t.foreground : tab.settled ? t.dim : t.muted)
          .when(here, (el) => el.font_medium())
          .child(threadTitle(tab, p)),
      )
      .when(Boolean(project) && !blocked && !hovered, (el) => el.child(div().flex_none().max_w(90).truncate().text_size(12).text_color(t.dim).child(project)))
      .when(blocked && !hovered, (el) =>
        el.child(div().flex_none().px(6).py(1).rounded(5).bg(alpha(t.blocked, 0.14)).text_size(11.5).text_color(t.blocked).child("Awaiting approval")),
      )
      .when(!hovered, (el) => el.child(this.diff(t, d) ?? div()).child(div().flex_none().w(24).text_right().text_size(12).text_color(t.dim).child(age(tab.settled ? tab.settled_at : tab.changed_at))))
      .when(hovered, (el) => el.child(actions));
  }

  // Spaces under a header per machine: this computer first, then servers by name.
  // A machine with no space still gets its header (that is how a connected server
  // that has no window yet stays visible).
  grouped(t, ps, all) {
    const folded = this.folded();
    const remote = [...new Set([...ps.map((s) => s.machine).filter(Boolean), ...machines().map((m) => m.name).filter(Boolean)])].sort();
    const names = [null, ...remote];
    return names.flatMap((m) => {
      const mine = ps.filter((s) => (s.machine ?? null) === m);
      const head = this.machineHead(t, m, folded.includes(m ?? "local"));
      if (folded.includes(m ?? "local")) return [head];
      return [head, ...(mine.length ? mine.map((s) => this.project(t, s, all, Boolean(m))) : [this.machineEmpty(t, m)])];
    });
  }

  machineHead(t, m, isFolded) {
    const key = m ?? "local";
    const up = !m || (machines().find((k) => k.name === m)?.layout ?? "loading") !== "unavailable";
    return h_flex()
      .id(`st-machine-${key}`)
      .mx(8)
      .pl(10)
      .pr(8)
      .h(26)
      .gap(8)
      .items_center()
      .rounded(7)
      .text_size(12)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.toggleMachine(key))
      .child(svg(icon(m ? "server" : "laptop")).size(15).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(m ?? "本机"))
      .child(this.tool(`st-mnew-${key}`, "plus", "New space", () => run("space.new", { machine: m ?? "" }), t, 12))
      .child(div().flex_none().size(6).rounded(3).bg(up ? t.ansi2 : t.dim))
      .child(svg(icon(isFolded ? "chevron-right" : "chevron-down")).size(11).flex_none());
  }

  machineEmpty(t, m) {
    return h_flex()
      .id(`st-machine-new-${m ?? "local"}`)
      .mx(8)
      .pl(26)
      .pr(8)
      .h(ROW + 2)
      .gap(8)
      .items_center()
      .rounded(8)
      .text_size(12.5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("space.new", { machine: m ?? "" }))
      .child(svg(icon("plus")).size(12))
      .child("新建工作区");
  }

  folded() {
    return shared("studio.foldedMachines") || [];
  }

  toggleMachine(key) {
    const now = this.folded();
    setShared("studio.foldedMachines", now.includes(key) ? now.filter((k) => k !== key) : [...now, key]);
  }

  // `sub`: a space listed under a server header: smaller icon and text, indented further.
  project(t, space, all, sub = false) {
    const open = !this.collapsed().includes(space.id);
    const key = `project-${space.id}`;
    const hovered = this.hover === key;
    const tabs = space.tabs.filter((tab) => !tab.settled);
    return v_flex()
      .gap(2)
      .child(
        h_flex()
          .id(`st-${key}`)
          .mx(8)
          .pl(10)
          .pr(8)
          .h(ROW + 2)
          .gap(10)
          .items_center()
          .rounded(8)
          .text_size(14.5)
          .font_medium()
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_hover((h, cx) => {
            if (h) this.hover = key;
            else if (this.hover === key) this.hover = null;
            cx.notify();
          })
          .on_click(() => this.toggleProject(space.id))
          .on_mouse_down("right", () => openOverlay({ mod: "abs", kind: "popup", width: 200, height: 260, props: { part: "menu", tab: "space", target: { id: space.id } } }))
          .child(div().flex_1().min_w(0).truncate().child(projectName(space)))
          .when(Boolean(space.machine), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(space.machine)))
          .when(hovered, (el) =>
            el
              .child(this.tool(`st-pmenu-${space.id}`, "ellipsis", "Project", () => openOverlay({ mod: "abs", kind: "popup", width: 200, height: 260, props: { part: "menu", tab: "space", target: { id: space.id } } }), t, 14))
              .child(this.tool(`st-pnew-${space.id}`, "square-pen", "New thread", () => this.newThread(space), t, 14)),
          ),
      )
      .when(open, (el) => el.children(tabs.map((tab) => this.row(t, space, tab, all, { list: "project", indent: true }))));
  }

  header(t) {
    const mode = this.mode();
    return v_flex()
      .child(
        h_flex()
          .mx(8)
          .pl(10)
          .pr(4)
          .pt(14)
          .pb(4)
          .items_center()
          .gap(2)
          .child(div().flex_1().text_size(12.5).text_color(t.dim).child("Threads"))
          .child(this.tool("st-add-project", "folder-plus", "Add project", (cx) => this.addProject(cx), t))
          .child(
            this.tool("st-filter", "list-filter", "Organize", () => {
              this.filterOpen = !this.filterOpen;
            }, t).when(this.filterOpen, (el) => el.bg(t.hover).text_color(t.foreground)),
          ),
      )
      .when(this.filterOpen, (el) =>
        el.child(
          v_flex()
            .mx(14)
            .mb(4)
            .p(4)
            .rounded(10)
            .bg(t.popover)
            .border_1()
            .border_color(t.border)
            .children(
              [["project", "By project"], ["chronological", "Chronological"]].map(([id, label]) =>
                h_flex()
                  .id(`st-mode-${id}`)
                  .h(28)
                  .px(8)
                  .gap(8)
                  .items_center()
                  .rounded(6)
                  .text_size(13)
                  .text_color(mode === id ? t.foreground : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    setShared("studio.organize", id);
                    this.filterOpen = false;
                    cx.notify();
                  })
                  .child(div().flex_1().child(label))
                  .when(mode === id, (el) => el.child(div().text_color(t.accent).child("✓"))),
              ),
            ),
        ),
      );
  }

  render(cx) {
    const t = theme();
    const all = panes();
    const ps = spaces();
    const pins = this.pins();
    const every = ps.flatMap((s) => s.tabs.map((tab) => ({ space: s, tab })));
    this.sharing = {};
    for (const r of every) {
      if (r.tab.settled) continue;
      const k = this.folderKey(r.space, lead(r.tab.id, all));
      if (k) this.sharing[k] = (this.sharing[k] ?? 0) + 1;
    }
    const pinned = pins.map((id) => every.find((r) => r.tab.id === id && !r.tab.settled)).filter(Boolean);
    const archived = every.filter((r) => r.tab.settled).sort((a, b) => (b.tab.settled_at ?? 0) - (a.tab.settled_at ?? 0));
    const chrono = every.filter((r) => !r.tab.settled).sort((a, b) => (b.tab.changed_at ?? 0) - (a.tab.changed_at ?? 0));
    const appearanceIcon = { system: "sun-moon", light: "sun", dark: "moon" }[this.appearance];
    const appearanceLabel = { system: "Theme: System", light: "Theme: Light", dark: "Theme: Dark" }[this.appearance];

    return v_flex()
      .size_full()
      .text_color(t.foreground)
      .child(
        v_flex()
          .gap(1)
          .child(this.nav("st-new", "square-pen", "New thread", () => this.newThread(null), t))
          .child(this.nav("st-search", "search", "Search", () => run("mod.open", { name: "picker" }), t))
          .child(this.nav("st-keys", "keyboard", "Shortcuts", () => run("app.help", {}), t)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .pb(12)
          .when(pinned.length > 0, (el) => el.child(div().h(12)).children(pinned.map((r) => this.row(t, r.space, r.tab, all, { list: "pinned" }))))
          .child(this.header(t))
          .when(this.mode() === "project", (el) => el.children(this.grouped(t, ps, all)))
          .when(this.mode() === "chronological", (el) =>
            el.children(chrono.map((r) => this.row(t, r.space, r.tab, all, { list: "chrono", project: projectName(r.space) }))),
          )
          .child(
            h_flex()
              .id("st-add-project-row")
              .mx(8)
              .pl(10)
              .h(ROW + 2)
              .gap(10)
              .items_center()
              .rounded(8)
              .text_size(13.5)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.addProject(cx))
              .child(svg(icon("folder-plus")).size(16))
              .child("Add project"),
          )
          .when(archived.length > 0, (el) =>
            el
              .child(
                h_flex()
                  .id("st-archived")
                  .mx(8)
                  .pl(10)
                  .pt(10)
                  .h(ROW + 10)
                  .gap(6)
                  .items_center()
                  .text_size(12.5)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.muted))
                  .on_click((_e, cx) => {
                    this.showArchived = !this.showArchived;
                    cx.notify();
                  })
                  .child(div().child(`Archived (${archived.length})`))
                  .child(svg(icon(this.showArchived ? "chevron-down" : "chevron-right")).size(13)),
              )
              .when(this.showArchived, (el) => el.children(archived.map((r) => this.row(t, r.space, r.tab, all, { list: "archived", project: projectName(r.space) })))),
          ),
      )
      .child(
        h_flex()
          .h(48)
          .px(8)
          .gap(2)
          .items_center()
          .child(
            h_flex()
              .id("st-settings")
              .flex_1()
              .h(ROW + 2)
              .px(10)
              .gap(10)
              .items_center()
              .rounded(8)
              .text_size(13.5)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => run("app.settings", {}))
              .child(svg(icon("settings")).size(16).text_color(t.muted))
              .child("Settings"),
          )
          .child(this.tool("st-appearance", appearanceIcon, appearanceLabel, (cx) => this.cycleAppearance(cx), t, 16).p(6)),
      );
  }
}
