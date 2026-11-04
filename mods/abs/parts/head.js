// The bar over the thread: its title and project, the "···" thread menu; on
// the right Open (in an editor or the file manager, the last one picked;
// the chevron picks another), Commit (opens the review panel on the
// changes, where the commit box is), the integrated terminal toggle, and
// the diff counter (+added -removed against HEAD), which opens and closes
// the review panel. Where the system draws no window buttons, they come
// last. This part also takes the layout's key commands (studio.terminal,
// studio.review, studio.files): they reach every copy of the mod, and only
// this one acts on them.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, theme, shared, setShared, openOverlay, closeOverlay, exec, notify, nextCommand, props, window as win } from "herdr";
import { icon, own, activeSpace, activeTab, lead, machineOf, isShown, toggleReview, toggleTerminal, terminalDrawer, diffStat } from "./lib.js";
import { threadTitle, projectName } from "./side.js";

// Where Open can send a folder, per platform: [id, label, program, args].
function editors(platform, dir) {
  if (platform === "macos")
    return [
      ["vscode", "VS Code", "open", ["-a", "Visual Studio Code", dir]],
      ["cursor", "Cursor", "open", ["-a", "Cursor", dir]],
      ["zed", "Zed", "open", ["-a", "Zed", dir]],
      ["files", "Finder", "open", [dir]],
      ["terminal", "Terminal", "open", ["-a", "Terminal", dir]],
    ];
  if (platform === "windows")
    return [
      ["vscode", "VS Code", "cmd", ["/c", "code", dir]],
      ["cursor", "Cursor", "cmd", ["/c", "cursor", dir]],
      ["files", "File Explorer", "explorer.exe", [dir]],
    ];
  return [
    ["vscode", "VS Code", "code", [dir]],
    ["cursor", "Cursor", "cursor", [dir]],
    ["zed", "Zed", "zed", [dir]],
    ["files", "Files", "xdg-open", [dir]],
  ];
}

function where() {
  const tab = activeTab();
  const space = activeSpace();
  const p = tab ? lead(tab.id) : null;
  return { tab, space, p, dir: p?.cwd || space?.folder || null, on: machineOf(p?.terminal) ?? space?.machine ?? null };
}

async function openIn(choice) {
  const { dir, on } = where();
  if (!dir) return;
  if (on) {
    notify({ title: "Open works for folders on this computer", body: `This thread runs on ${on}.`, level: "info" });
    return;
  }
  const e = editors(win()?.platform, dir).find((x) => x[0] === choice) ?? editors(win()?.platform, dir)[0];
  setShared("studio.editor", e[0]);
  const r = await exec(e[2], e[3]).catch((err) => ({ code: 1, stderr: String(err) }));
  if (r.code !== 0) notify({ title: `Couldn't open ${e[1]}`, body: (r.stderr || "").trim().split("\n")[0] || "Is it installed?", level: "error" });
}

function button(t, id, children, onClick, { tip, framed = true, on = false, hoverBg = true } = {}) {
  return own(
    h_flex()
      .id(id)
      .h(22)
      .px(framed ? 8 : 5)
      .gap(6)
      .items_center()
      .justify_center()
      .rounded(8)
      .when(framed, (el) => el.border_1().border_color(t.border))
      .text_size(13)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((s) => hoverBg ? s.bg(t.hover).text_color(t.foreground) : s.text_color(t.foreground))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click(onClick)
      .children(children),
  );
}

export class Header {
  init(cx) {
    this.stat = null;
    this.statKey = null;
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "terminal") toggleTerminal(run);
        else if (c === "review") toggleReview(run, "changes");
        else if (c === "files") toggleReview(run, "files");
        else if (c === "sidebar") run("layout.toggle", { id: "sidebar" });
        cx.notify();
      }
    });
  }

  refresh(cx) {
    const { dir, on } = where();
    const key = JSON.stringify([on, dir]);
    if (this.busy || !dir) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const s = await diffStat(dir, on).catch(() => null);
      this.busy = false;
      if (key !== this.statKey || JSON.stringify(s) !== JSON.stringify(this.stat)) {
        this.stat = s;
        this.statKey = key;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const w = win() ?? {};
    const { tab, space, p, dir, on } = where();
    // A folder change (new thread, cd) shows at once, numbers follow.
    if (JSON.stringify([on, dir]) !== this.statKey && !this.busy) this.refresh(cx);
    const stat = JSON.stringify([on, dir]) === this.statKey ? this.stat : null;
    const sidebarHidden = !isShown("sidebar");
    const mac = w.platform === "macos" && !w.fullscreen;
    const editor = editors(w.platform, dir ?? "").find((e) => e[0] === shared("studio.editor")) ?? editors(w.platform, dir ?? "")[0];
    const reviewOpen = isShown("review");

    return h_flex()
      .size_full()
      .pl(sidebarHidden && mac ? 84 : 20)
      .pr(12)
      .gap(8)
      .items_center()
      .when(sidebarHidden, (el) =>
        el.child(button(t, "sh-unfold", [svg(icon("panel-left")).size(16)], () => run("layout.show", { id: "sidebar" }), { framed: false, tip: "Show sidebar" })),
      )
      .when(Boolean(tab), (el) =>
        el
          .child(div().flex_shrink(1).min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(threadTitle(tab, p)))
          .child(div().flex_none().max_w(200).truncate().text_size(13.5).text_color(t.dim).child(projectName(space)))
          .child(
            button(t, "sh-menu", [svg(icon("ellipsis")).size(16)], () =>
              openOverlay({ mod: "abs", kind: "popup", width: 200, props: { part: "menu", tab: "tab", target: { id: tab.id, space: space.id, settled: tab.settled } } }), { framed: false, tip: "Thread" }),
          ),
      )
      .child(div().flex_1())
      .when(false, (el) =>
        el.child(
          own(
            h_flex()
              .h(28)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .text_size(13)
              .text_color(t.muted)
              .child(
                h_flex()
                  .id("sh-open")
                  .h_full()
                  .pl(10)
                  .pr(6)
                  .gap(6)
                  .items_center()
                  .rounded_l(8)
                  .cursor_pointer()
                  .hover((s) => hoverBg ? s.bg(t.hover).text_color(t.foreground) : s.text_color(t.foreground))
                  .tooltip(`Open in ${editor[1]}`)
                  .on_click(() => openIn(editor[0]))
                  .child(svg(icon("code-xml")).size(15))
                  .child("Open"),
              )
              .child(
                div()
                  .id("sh-open-pick")
                  .h_full()
                  .px(5)
                  .flex()
                  .items_center()
                  .rounded_r(8)
                  .cursor_pointer()
                  .hover((s) => hoverBg ? s.bg(t.hover).text_color(t.foreground) : s.text_color(t.foreground))
                  .on_click(() => openOverlay({ mod: "abs", kind: "popup", width: 200, props: { part: "open-menu" } }))
                  .child(svg(icon("chevron-down")).size(13)),
              ),
          ),
        ),
      )
      .when(false, (el) =>
        el.child(
          button(t, "sh-commit", [svg(icon("git-commit-horizontal")).size(15), div().child("Commit")], () => {
            run("layout.select", { stack: "review-body", child: "changes" });
            if (!reviewOpen) run("layout.show", { id: "review" });
          }, { tip: "Review and commit" }),
        ),
      )
      .child(
        button(
          t,
          "sh-quick",
          [svg(icon("code-xml")).size(15)],
          () => openOverlay({ mod: "abs", kind: "popup", width: 180, props: { part: "quick-open" } }),
          { framed: false, tip: "Open" },
        ),
      )
      .children(
        [
          ["sessions", "session", "会话"],
          ["board", "board", "看板"],
          ["index", "graph", "图谱"],
          ["log", "log", "日志"],
        ].map(([id, glyph, tip]) => {
          const on = reviewOpen && (shared("abs.view") ?? "sessions") === id;
          return button(
            t,
            `sh-kb-${id}`,
            [svg(`mods/abs/icons/${id}.svg`).size(15)],
            () => {
              if (on) run("layout.hide", { id: "review" });
              else {
                setShared("abs.view", id);
                if (!reviewOpen) run("layout.show", { id: "review" });
              }
            },
            { framed: false, on, hoverBg: false, tip: on ? `收起${tip}` : tip },
          );
        }),
      );
  }
}

// The status-bar Open button's menu: a plain four-item list, no "last used" state.
export class QuickOpen {
  init(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  render() {
    const t = theme();
    const { dir } = where();
    const items = [
      ["vscode", "VS Code", "code-xml", () => openIn("vscode")],
      ["zed", "Zed", "square-pen", () => openIn("zed")],
      ["files", "文件窗口", "folder-open", () => dir && exec("open", [dir])],
      ["terminal", "新终端", "square-terminal", () => run("terminal.open", { folder: dir ?? undefined, place: "right" })],
    ];
    return v_flex()
      .id("sq-menu")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(props().overlay);
      })
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .children(
        items.map(([id, label, iconName, run_]) =>
          h_flex()
            .id(`sq-${id}`)
            .h(30)
            .px(9)
            .gap(8)
            .items_center()
            .rounded(7)
            .text_color(t.foreground)
            .cursor_pointer()
            .hover((s) => s.bg(t.selected))
            .on_click(() => {
              closeOverlay(props().overlay);
              run_();
            })
            .child(svg(icon(iconName)).size(14))
            .child(div().flex_1().child(label)),
        ),
      );
  }
}

// The chevron's menu: where Open sends the folder, the last one checked.
export class OpenMenu {
  init(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  render() {
    const t = theme();
    const w = win() ?? {};
    const { dir } = where();
    const chosen = shared("studio.editor");
    const list = editors(w.platform, dir ?? "");
    return v_flex()
      .id("so-menu")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(props().overlay);
      })
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .child(div().px(9).pt(4).pb(6).text_size(11.5).text_color(t.dim).child("Open in"))
      .children(
        list.map((e, i) =>
          h_flex()
            .id(`so-${e[0]}`)
            .h(30)
            .px(9)
            .gap(8)
            .items_center()
            .rounded(7)
            .text_color(t.foreground)
            .cursor_pointer()
            .hover((s) => s.bg(t.selected))
            .on_click(() => {
              closeOverlay(props().overlay);
              openIn(e[0]);
            })
            .child(div().flex_1().child(e[1]))
            .when(chosen === e[0] || (!chosen && i === 0), (el) => el.child(div().text_color(t.accent).child("✓"))),
        ),
      );
  }
}
