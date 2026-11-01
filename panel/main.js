// ABS 记忆库面板：把 .brain 的 index / todo / log 读成三块卡片。
// 目录从当前空间的工作目录往上找 .brain，找不到就用 ~/.brain。
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, readTextFile, watchFolder, exec, hc, theme, home, openOverlay, nextCommand } from "herdr";

// ── 解析 ─────────────────────────────────

// todo.md 的顶层任务行，形如：
// - [ ] [进行中] id [[作者]] — 标题 (认领 2026-11-01 会话)
// - [x] id [[作者]] — 标题 — 结语 【落地】 (完成 2026-10-22 会话)
function parseTodo(text) {
  const out = { doing: [], done: [], doingTitle: "Todo" };
  let group = "", archived = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ")) {
      const name = line.slice(3).trim();
      archived = false;
      if (name === "Done") { group = "done"; }
      else if (!out.seen) { out.seen = true; out.doingTitle = name || "Todo"; group = "doing"; }
      continue;
    }
    if (line.startsWith("### ")) {
      const name = line.slice(4).trim();
      archived = name === "Archived";
      group = archived ? "" : (group === "doing" ? "doing" : "done");
      continue;
    }
    // 缩进的是子项，收进上一条任务里；[x] 扣完成标记
    if (/^\s*-\s/.test(raw) && line !== raw.trimStart()) {
      const parent = out[group === "doing" ? "doing" : "done"].at(-1);
      if (parent) {
        const rest = line.trim().replace(/^-\s+/, "");
        const done = rest.startsWith("[x]");
        const kid = rest.replace(/^\[[ x]\]\s*/, "").trim();
        if (kid) { parent.kids++; parent.children.push({ text: kid, done }); }
      }
      continue;
    }
    if (!line.startsWith("- ") || archived) continue;
    const task = parseTask(line, group === "doing" ? "doing" : "done");
    if (task) out[task.group].push(task);
  }
  return out;
}

function parseTask(line, group) {
  let body = line.slice(2).trim(), state = "", done = false;
  const box = /^\[([ x])\]\s+/.exec(body);
  if (box) {
    done = box[1] === "x";
    body = body.slice(box[0].length);
    const st = /^\[([^\]]+)\]\s*/.exec(body);
    if (st) { state = st[1]; body = body.slice(st[0].length); }
  }
  if (!body.includes("[[")) return null;
  const noteAt = body.indexOf(" — ");
  const main = noteAt < 0 ? body : body.slice(0, noteAt);
  const note = noteAt < 0 ? "" : body.slice(noteAt + 3);
  const id = (main.trim().split(/\s+/)[0] || "");
  const who = /\[\[([^\]]+)\]\]/.exec(main)?.[1] ?? "";
  const date = /\(认领 ([^)]*)\)/.exec(main)?.[1] ?? /\(完成 ([^)]*)\)/.exec(note)?.[1] ?? "";
  let title = main;
  for (const cut of ["[[", "(认领 "]) {
    const at = title.indexOf(cut);
    if (at >= 0) title = title.slice(0, at);
  }
  title = title.slice(title.indexOf(id) + id.length).trim();
  return { group, done, state, id, who, date, title: title || id, note, verdict: /【([^】]+)】/.exec(note)?.[1] ?? "", kids: 0, children: [], line: line.trim() };
}

// index.md 的分类计数，形如 `## Concepts` 后若干 `- [[页]] — 一句话`。
function parseIndex(text) {
  const sections = [];
  let current = null;
  let rules = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ")) {
      const head = line.slice(3).trim();
      const count = /（\s*(\d+)\s*(?:页|条)?\s*）/.exec(head);
      if (head === "Rules") { current = null; continue; }
      current = { name: count ? head.slice(0, head.indexOf("（")).trim() : head, items: [], stated: count ? Number(count[1]) : null };
      sections.push(current);
      continue;
    }
    if (line.startsWith("- ") && current) {
      const link = /\[\[([^\]]+)\]\]/.exec(line)?.[1];
      const about = line.includes(" — ") ? line.slice(line.indexOf(" — ") + 3).trim() : "";
      current.items.push({ name: link ?? line.slice(2).trim(), about });
    } else if (line.startsWith("- ") && !current) {
      rules++;
    }
  }
  return { sections: sections.filter((s) => s.items.length || s.stated), rules };
}

// log.md 每条一行：## [YYYY-MM-DD HH:MM] [[作者]] kind | 正文
function parseLog(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("## [")) continue;
    const close = line.indexOf("] ", 4);
    if (close < 0) continue;
    const when = line.slice(4, close).trim();
    let rest = line.slice(close + 2).trim();
    const who = /^\[\[([^\]]+)\]\]\s*/.exec(rest);
    if (who) rest = rest.slice(who[0].length);
    const bar = rest.indexOf(" | ");
    const kind = bar < 0 ? "" : rest.slice(0, bar).trim();
    const text = (bar < 0 ? rest : rest.slice(bar + 3)).trim();
    out.push({ when, who: who?.[1] ?? "", kind, text });
  }
  return out.reverse();
}

// ── 面板 ─────────────────────────────────

export default class AbsPanel extends View {
  init(_props, cx) {
    this.brainDir = null;
    this.brainOn = null;
    this.todo = { doing: [], done: [] };
    this.index = { sections: [], rules: 0 };
    this.log = [];
    this.view = "board";
    this.loading = true;
    this.note = null;
    this.watched = null;
    this.watchKey = null;
    this.refresh(cx);
    // 快捷键 / 命令行能触发的命令：abs-panel.open-zed、abs-panel.open-code。
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "open-zed") this.openIn("zed");
        else if (cmd === "open-code") this.openIn("code");
        cx.notify();
      }
    });
    // 5 秒一轮：工作目录换了、.brain 改了都在这轮里发现。
    cx.timer.every(5000, (cx) => this.refresh(cx));
  }

  // 当前落点：聚焦 pane 的目录、空间目录，以及它所在的机器（null = 本机）。
  where() {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { dir: pane?.cwd || f?.cwd || space?.folder || null, on: space?.machine ?? null };
  }

  // 工作目录或机器变了就立刻重读，不等下一个定时器。
  check(where, cx) {
    const key = `${where.on ?? ""}|${where.dir ?? ""}`;
    if (key === this.watchKey) return;
    this.watchKey = key;
    this.refresh(cx);
  }

  refresh(cx) {
    // 定时器、目录监听、切目录会同时叫；只留最新一轮，旧的结果丢掉。
    const ticket = (this.refreshTicket ?? 0) + 1;
    this.refreshTicket = ticket;
    const at = this.where();
    const context = `${at.on ?? ""}|${at.dir ?? ""}`;
    // 提示只在「它属于这类消息」时清，不要抹掉 openIn 写的错误。
    if (this.noteKind === "read") this.note = null;
    cx.spawn(async (cx) => {
      try {
        const dir = await this.findBrain(at);
        if (ticket !== this.refreshTicket || context !== this.keyNow()) return;
        this.brainDir = dir;
        this.brainOn = dir ? at.on : null;
        if (dir !== this.watched) this.watched = null;
        this.watch(cx);
        const read = (name) => dir ? readTextFile(`${dir}/${name}`, { on: at.on }).catch(() => null) : Promise.resolve(null);
        const [todo, index, log] = await Promise.all([read("todo.md"), read("index.md"), read("log.md")]);
        if (ticket !== this.refreshTicket || context !== this.keyNow()) return;
        this.todo = todo ? parseTodo(todo) : { doing: [], done: [] };
        this.index = index ? parseIndex(index) : { sections: [], rules: 0 };
        this.log = log ? parseLog(log) : [];
        // findBrain 自己写的原因（比如连不上机器）优先于「没找到」。
        if (dir) { this.note = null; this.noteKind = null; }
        else if (this.note == null) { this.note = "没找到 .brain 目录"; this.noteKind = "read"; }
      } catch (e) {
        if (ticket === this.refreshTicket) { this.note = String(e); this.noteKind = "open"; }
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  keyNow() {
    const at = this.where();
    return `${at.on ?? ""}|${at.dir ?? ""}`;
  }

  // 工作目录往上逐层找 .brain，都没有就用该机器上的 ~/.brain。
  async findBrain(at) {
    const on = at.on;
    if (at.dir) {
      let dir = at.dir.replace(/\/$/, "");
      for (let i = 0; i < 8 && dir && dir !== "/"; i++) {
        const text = await readTextFile(`${dir}/.brain/todo.md`, { on }).catch(() => null);
        if (text !== null) return `${dir}/.brain`;
        const cut = dir.lastIndexOf("/");
        dir = cut <= 0 ? "" : dir.slice(0, cut);
      }
    }
    // 家目录得问那台机器自己：远程的 HOME 往往不是本地那个。
    let homeDir = home();
    if (on) {
      const r = await exec("sh", ["-c", "exec printf %s \"$HOME\""], { on }).catch(() => null);
      if (r?.code !== 0 || !r?.stdout.trim()) {
        this.note = `连不上 ${on}，读不到它上面的 .brain`;
        return null;
      }
      homeDir = r.stdout.trim();
    }
    const homeBrain = `${homeDir}/.brain`;
    const text = await readTextFile(`${homeBrain}/todo.md`, { on }).catch(() => null);
    return text !== null ? homeBrain : null;
  }

  // .brain 变了就重读，不用等定时器。
  // 本机才能监听目录；远程靠 5 秒一轮的定时器。
  watch(cx) {
    const dir = this.brainDir;
    if (!dir || this.brainOn || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      // 目录被删或改名时 watchFolder 会报错。等一会重试，不能就此停掉，
      // 否则目录回来之后（或 brainDir 没变）就再也不监听了。
      while (this.watched === dir) {
        try { await watchFolder(dir); } catch { await new Promise((r) => setTimeout(r, 5000)); continue; }
        if (this.watched !== dir) return;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  // ── 卡片 ───────────────────────────────

  card(title, badge, body) {
    const t = theme();
    return v_flex().w_full().flex_none().rounded(10).overflow_hidden().bg(t.raised)
      .border_1().border_color(t.border)
      .child(h_flex().h(32).flex_none().px(9).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
        .when(badge != null, (e) => e.child(div().px(5).rounded(4).bg(t.chrome).text_size(10.5).text_color(t.muted).child(String(badge))))
        .child(div().flex_1()))
      .child(v_flex().px(4).py(5).gap(3).children(body));
  }

  // 三色：绿=进行中，红=暂停（滞留/搁置），橙=完成。
  // 看 checkbox 本身而不是所在区：Done 区里也可能有没做完的 [ ] 行。
  stateColor(task) {
    const t = theme();
    if (task.done) return t.ansi3;
    const paused = /滞留|搁置|讨论中/.test(task.state ?? "");
    return paused ? t.ansi1 : t.ansi2;
  }

  // 点开详情：任务带全文与子项，图谱与日志各自带上自己的正文。
  openDetail(kind, item) {
    const t = theme();
    if (kind === "task") {
      const meta = [item.state, item.verdict, item.id, item.who, item.date].filter(Boolean);
      const body = [
        ...(item.note ? [item.note] : []),
        ...(item.children.length ? ["", "子项：", ...item.children.map((k) => `${k.done ? "☑" : "☐"} ${k.text}`)] : []),
        "",
        "原始行：",
        item.line,
      ];
      openOverlay({
        mod: "abs-detail", kind: "dialog", width: 620, height: 460,
        props: { title: item.title, meta, body },
      });
      return;
    }
    if (kind === "section") {
      openOverlay({
        mod: "abs-detail", kind: "dialog", width: 640, height: 520,
        props: { title: item.name, meta: [`${item.items.length} 条`], body: item.items.map((x) => `· ${x.name}${x.about ? " — " + x.about : ""}`) },
      });
      return;
    }
    openOverlay({
      mod: "abs-detail", kind: "dialog", width: 640, height: 420,
      props: { title: item.text.split("\n")[0] || "(空)", meta: [item.kind, item.when, item.who].filter(Boolean), body: item.text.split("\n") },
    });
  }

  // 一条任务：名字最大，下面是说明；左上角圆点看状态，子项缩进列在下面。
  taskRow(task) {
    const t = theme();
    const dot = this.stateColor(task);
    const detail = task.note || task.title;
    const kids = task.children ?? [];
    // 子项多时只列前 3 条，其余点开详情看。
    const shownKids = kids.slice(0, 3);
    return v_flex().w_full().flex_none().gap(2).px(6).py(5).rounded(7).bg(t.background)
      .border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.openDetail("task", task))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).flex_none().rounded(4).bg(dot))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(task.title))
        .when(kids.length > 0, (e) => e.child(div().text_size(10).text_color(t.dim).child(`${kids.length} 子项`))))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(detail))
        .when(Boolean(task.verdict), (e) => e.child(div().text_size(10).text_color(dot).child(task.verdict))))
      // 子项：缩进 + 左侧竖线，看得出从属于上面这条
      .when(shownKids.length > 0, (e) => e.child(v_flex().mt(2).pl(9).gap(1)
        .children(shownKids.map((kid) => h_flex().gap(5).items_center()
          .child(div().w(1).h(11).flex_none().rounded(1).bg(kid.done ? t.ansi3 : t.border))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(kid.done ? t.dim : t.muted).child(kid.text))))
        .when(kids.length > shownKids.length, (el) => el.child(div().pl(6).text_size(10).text_color(t.dim).child(`还有 ${kids.length - shownKids.length} 条…`)))));
  }

  boardCard() {
    const t = theme();
    const doing = this.todo.doing ?? [], done = this.todo.done ?? [];
    return this.card(
      "看板",
      `${doing.length} 进行中`,
      [
        ...(doing.length ? doing.map((task) => this.taskRow(task)) : [div().px(6).text_size(11.5).text_color(t.dim).child("没有进行中的任务")]),
        ...(done.length ? [
          div().px(6).mt(3).text_size(10.5).text_color(t.dim).child(`最近完成 ${done.length} 条`),
          ...done.slice(0, 5).map((task) => this.taskRow(task)),
        ] : []),
      ],
    );
  }

  indexCard() {
    const t = theme();
    const sections = (this.index.sections ?? []).filter((s) => s.name !== "Sessions" && s.name !== "Sources").slice(0, 8);
    return this.card(
      "图谱索引",
      `${(this.index.sections ?? []).reduce((n, s) => n + (s.items.length || s.stated || 0), 0)} 页`,
      [
        ...(sections.length ? sections.map((s) => h_flex().w_full().flex_none().gap(6).items_center().px(6).py(5).rounded(7)
          .bg(t.background).border_1().border_color(t.border).cursor_pointer().hover((el) => el.bg(t.hover))
          .on_click(() => this.openDetail("section", s))
          .child(div().size(7).flex_none().rounded(4).bg(t.ansi6))
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(s.name))
          .child(div().text_size(10.5).text_color(t.muted).child(`${s.items.length || s.stated} 页`))) : [div().px(6).text_size(11.5).text_color(t.dim).child("索引为空")]),
        ...(this.index.rules > 0 ? [div().px(6).text_size(10.5).text_color(t.dim).child(`另有 ${this.index.rules} 条规则`)] : []),
      ],
    );
  }

  logCard() {
    const t = theme();
    const entries = (this.log ?? []).slice(0, 12);
    return this.card(
      "最近日志",
      `${this.log.length} 条`,
      entries.length ? entries.map((e) => {
        const head = e.text.split("\n")[0] || "(空)";
        return v_flex().w_full().flex_none().gap(2).px(6).py(5).rounded(7)
          .bg(t.background).border_1().border_color(t.border).cursor_pointer().hover((el) => el.bg(t.hover))
          .on_click(() => this.openDetail("entry", e))
          .child(h_flex().gap(6).items_center()
            .child(div().size(7).flex_none().rounded(4).bg(e.kind === "dev" ? t.ansi2 : t.ansi6))
            .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(head))
            .child(div().text_size(10).text_color(t.dim).child(e.when)))
          .when(Boolean(e.kind), (el) => el.child(div().px(1).text_size(10).text_color(t.muted).child(e.kind)));
      }) : [div().px(6).text_size(11.5).text_color(t.dim).child("还没有日志")],
    );
  }

  // 用外部编辑器打开当前项目。本机直接开目录，远程用 ssh 打开那台机器上的目录。
  openIn(editor) {
    const at = this.where();
    const dir = at.dir;
    if (!dir) { this.note = "没有可打开的目录"; this.noteKind = "open"; return; }
    const bin = editor === "zed"
      ? "/Applications/Zed.app/Contents/MacOS/cli"
      : "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    this.note = at.on ? `正在用 ${editor} 打开 ${at.on} 上的目录…` : null;
    this.noteKind = at.on ? "open" : null;
    const finish = () => { if (this.noteKind === "open") { this.note = null; this.noteKind = null; } };
    const fail = (e) => { this.note = `打开失败：${e}`; this.noteKind = "open"; };
    if (!at.on) {
      exec(bin, [dir]).then(finish).catch(fail);
      return;
    }
    // 机器名（fnos）和 ssh 别名（FNOS）不一，先查 hc 拿 target。
    hc(["machine", "ls"]).then((r) => {
      let host = at.on;
      try {
        const name = String(at.on).toLowerCase();
        for (const m of JSON.parse(r.stdout).machines) {
          if (String(m.name).toLowerCase() === name) { host = m.target || m.name; break; }
        }
      } catch { /* 查不到就用原名 */ }
      const args = editor === "zed" ? [`ssh://${host}${dir}`] : ["--remote", `ssh-remote+${host}`, dir];
      return exec(bin, args).then(finish);
    }).catch(fail);
  }

  render(cx) {
    // 空间/pane 一换，spaces() 和 focused() 变了就会重渲染；这里立刻跟上，不等定时器。
    this.check(this.where(), cx);
    const t = theme();
    const tab = (id, label) => h_flex().id(`abs-${id}`).h(24).px(9).flex_none().items_center().rounded(6).text_size(11.5)
      .bg(this.view === id ? t.selected : t.chrome).text_color(this.view === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.view = id; cx.notify(); }).child(label);
    const body = this.view === "board" ? [this.boardCard(), this.logCard()] : this.view === "index" ? [this.indexCard()] : [this.logCard(), this.boardCard()];
    return v_flex().id("abs-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(38).flex_none().px(12).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().text_size(12.5).font_semibold().mr(4).child("ABS 记忆库"))
        .child(tab("board", "看板")).child(tab("index", "图谱")).child(tab("log", "日志"))
        .child(div().flex_1())
        .child(div().id("abs-refresh").size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.refresh(cx)).child(div().text_size(13).child("↻"))))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().p(10).child(v_flex().gap(10).w_full()
        .when(this.note != null, (e) => e.child(div().px(9).py(7).rounded(8).bg(t.raised).border_1().border_color(t.border).text_size(11).text_color(t.ansi3).child(this.note)))
        .children(body)))
      .child(h_flex().h(26).flex_none().px(10).gap(6).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child((this.brainOn ? `${this.brainOn}:` : "") + (this.brainDir ?? (this.loading ? "读取中…" : "无 .brain"))))
        .child(h_flex().id("abs-open-zed").size(22).flex_none().items_center().justify_center()
          .cursor_pointer().hover((s) => s.opacity(0.75))
          .on_click(() => this.openIn("zed")).child(image("abs-icons/zed.svg").size(14)))
        .child(h_flex().id("abs-open-code").size(22).flex_none().items_center().justify_center()
          .cursor_pointer().hover((s) => s.opacity(0.75))
          .on_click(() => this.openIn("code")).child(image("abs-icons/vscode.svg").size(14))));
  }
}
