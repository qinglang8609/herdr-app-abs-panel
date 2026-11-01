// ABS 记忆库面板：把 .brain 的 index / todo / log 读成三块卡片。
// 目录从当前空间的工作目录往上找 .brain，找不到就用 ~/.brain。
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, readTextFile, writeTextFile, watchFolder, exec, hc, theme, home, run, appHome, openOverlay, nextCommand } from "herdr";

// ── 会话（pi 历史）───────────────────────

const LIMIT = 200;

function norm(p) {
  return String(p || "").replace(/\/+$/, "");
}

// 相对时间
function ago(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  const t = new Date(ms);
  return `${t.getMonth() + 1}月${t.getDate()}日`;
}

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

// 卡片底色：要比面板底明显深一档，主题里的 ansi0 只深一点点，看不出来。
function cardBg(t) {
  const bg = String(t.background || "").toLowerCase();
  const m = /^#([0-9a-f]{6})$/.exec(bg);
  const dark = m
    ? (parseInt(m[1].slice(0, 2), 16) * 0.299 + parseInt(m[1].slice(2, 4), 16) * 0.587 + parseInt(m[1].slice(4, 6), 16) * 0.114) < 128
    : true;
  return dark ? "#16171d" : "#ececf0";
}

// 自带 UTF-8 + base64：这套运行时没有 TextEncoder / btoa。
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function toBase64(str) {
  const bytes = utf8Bytes(String(str));
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : chars[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : chars[c & 63];
  }
  return out;
}

function remoteScanCommand(scriptText, limit) {
  const b64 = toBase64(String(scriptText));
  return `tmp=$(mktemp /tmp/scan-XXXXXX.js); printf %s '${b64}' | base64 -d > "$tmp" 2>/dev/null; node "$tmp" --limit ${limit}; rc=$?; rm -f "$tmp"; exit $rc`;
}

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
  const rules = [];
  let current = null;
  let inRules = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ")) {
      const head = line.slice(3).trim();
      const count = /（\s*(\d+)\s*(?:页|条)?\s*）/.exec(head);
      // Rules 不是图谱页，单独收成铁律清单，不参与「页数」统计。
      inRules = head === "Rules";
      current = inRules ? null : { name: count ? head.slice(0, head.indexOf("（")).trim() : head, items: [], stated: count ? Number(count[1]) : null };
      if (current) sections.push(current);
      continue;
    }
    if (!line.startsWith("- ")) continue;
    if (inRules) {
      const text = line.slice(2).trim();
      if (text) rules.push(text);
    } else if (current) {
      const link = /\[\[([^\]]+)\]\]/.exec(line)?.[1];
      const about = line.includes(" — ") ? line.slice(line.indexOf(" — ") + 3).trim() : "";
      current.items.push({ name: link ?? line.slice(2).trim(), about });
    }
  }
  return { sections: sections.filter((s) => s.items.length || s.stated), rules, ruleCount: rules.length };
}

// 把 index.md 的 ## Rules 段换成给定的条目，其余部分原样不动。
// 文件里没有 ## Rules 就补一个（插在第一个二级标题前）。
function rebuildRules(text, change) {
  const lines = text.split("\n");
  let start = lines.findIndex((l) => l.trim() === "## Rules");
  if (start < 0) {
    const at = lines.findIndex((l) => l.startsWith("## "));
    const insert = at < 0 ? lines.length : at;
    lines.splice(insert, 0, "## Rules", "");
    start = insert;
  }
  // 段尾：下一个二级标题之前，后面的空行归下一段
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  let bodyEnd = end;
  while (bodyEnd > start + 1 && lines[bodyEnd - 1].trim() === "") bodyEnd--;

  const current = [];
  for (const line of lines.slice(start + 1, bodyEnd)) {
    const t = line.trim();
    if (t.startsWith("- ")) {
      const item = t.slice(2).trim();
      if (item) current.push(item);
    }
  }
  const next = change(current);
  const body = next.length ? ["", ...next.map((r) => `- ${r}`)] : [];
  lines.splice(start + 1, bodyEnd - start - 1, ...body);
  return lines.join("\n");
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
    this.index = { sections: [], rules: [] };
    this.log = [];
    this.view = "sessions";
    this.loading = true;
    // 会话页的状态
    this.sessions = [];
    this.machine = null;
    this.confirmDelete = null;
    this.scriptText = null;
    this.scriptPath = null;
    this.loadingScript = false;
    // 会话页的错误单独存，不跟 .brain 的 note 混。
    this.error = null;
    // 扫描票号：定时器和手动刷新同时触发时，只认最新一轮。
    this.scanTicket = 0;
    // 本机有没有 node，探一次就够了。
    this.hasNode = null;
    // 扫描进行中标志，防止定时器和手动刷新叠跑。
    this.scanning = false;
    this.note = null;
    this.watched = null;
    this.watchKey = null;
    this.refresh(cx);
    // 会话页：读扫描脚本，读完自己会扫一次；另外每 10 秒扫一轮。
    this.loadScript(cx);
    // 立刻扫一次，不然要等第一个 10 秒定时器，界面一直空着。
    this.sessRefresh(cx);
    cx.timer.every(10000, (cx) => this.sessRefresh(cx));
    // 快捷键 / 命令行能触发的命令：abs-panel.open-zed、abs-panel.open-code。
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "open-zed") this.openIn("zed");
        else if (cmd === "open-code") this.openIn("code");
        else if (cmd.startsWith("rule-add:")) this.addRuleText(cmd.slice("rule-add:".length));
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
        this.index = index ? parseIndex(index) : { sections: [], rules: [] };
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
      // 目录被删或改名时 watchFolder 会报错。不能就此停掉，停一下接着试。
      // herdr-app 没有 setTimeout，只能用 cx.timer。
      while (this.watched === dir) {
        let failed = false;
        try {
          await watchFolder(dir);
        } catch {
          failed = true;
        }
        if (this.watched !== dir) return;
        if (!failed) {
          this.refresh(cx);
          cx.notify();
        }
        // 失败时隔 5 秒再试，成功时 watchFolder 自己会等下一次变化。
        if (failed) await new Promise((resolve) => cx.timer.after(5000, resolve));
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
    // 只隐藏空分类，不按名字排除：Sessions 常有十几条，以前被无條件过滤掉了。
    const sections = (this.index.sections ?? []).filter((s) => s.items.length || s.stated);
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
      ],
    );
  }

  // 铁律卡：图谱顶上的独立一块，能直接改、能加。
  rulesCard() {
    const t = theme();
    const rules = this.index.rules ?? [];
    // writeTextFile 只能写本机，远程的 index.md 改不了。
    const editable = !this.brainOn && Boolean(this.brainDir);
    // 默认只摆前 3 条，多的收起来；点「全部」展开。删行按原编号，展开不展开都对。
    const LIMIT = 3;
    const expanded = this.rulesOpen === true;
    const shown = expanded ? rules : rules.slice(0, LIMIT);
    const hidden = rules.length - shown.length;
    return this.card(
      "铁律",
      `${rules.length} 条`,
      [
        ...(shown.length ? shown.map((text, i) => h_flex().w_full().flex_none().gap(4).items_center().px(6).py(5).rounded(7)
          .bg(t.background).border_1().border_color(t.border)
          .child(div().text_size(10).flex_none().text_color(t.ansi3).child(`${i + 1}`))
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).child(text))
          .when(editable, (e) => e.child(div().id(`abs-rule-del-${i}`).size(18).flex_none().flex().items_center().justify_center()
            .rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.ansi1))
            .on_click(() => this.removeRule(i)).child("×")))) : [div().px(6).text_size(11.5).text_color(t.dim).child("还没有铁律")]),
        ...(hidden > 0 ? [h_flex().id("abs-rule-more").h(22).px(6).flex_none().items_center().text_size(10.5).text_color(t.dim)
          .cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.rulesOpen = true; cx.notify(); }).child(`还有 ${hidden} 条，展开`)] : []),
        ...(expanded && rules.length > LIMIT ? [h_flex().id("abs-rule-less").h(22).px(6).flex_none().items_center().text_size(10.5).text_color(t.dim)
          .cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.rulesOpen = false; cx.notify(); }).child("收起")] : []),
        editable
          ? h_flex().id("abs-rule-add").mt(2).h(26).px(8).flex_none().items_center().justify_center().gap(5).rounded(7)
            .bg(t.raised).border_1().border_color(t.border).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => this.addRule()).child("+ 添加铁律")
          : div().px(6).text_size(10.5).text_color(t.dim).child(this.brainOn ? `${this.brainOn} 上的文件改不了，只能看` : "没找到 index.md"),
      ],
    );
  }

  // 改 index.md 的 Rules 段：先整份读下来，换掉这一段，再整份写回。
  async editRules(change) {
    if (this.brainOn || !this.brainDir) return;
    const path = `${this.brainDir}/index.md`;
    try {
      const text = await readTextFile(path).catch(() => null);
      if (text == null) { this.note = "读不到 index.md"; this.noteKind = "open"; return; }
      const next = change(text);
      if (next === text) return;
      // expected 传原文：这期间文件被別处改了，写入会被拒绝，不会覆盖别人的改动。
      await writeTextFile(path, next, text);
      this.note = null;
      this.noteKind = null;
      this.refresh(this.lastCx);
    } catch (e) {
      this.note = `写 index.md 失败：${e}`;
      this.noteKind = "open";
    }
  }

  addRule() {
    openOverlay({
      mod: "abs-detail", kind: "dialog", width: 520, height: 240,
      props: {
        title: "添加铁律",
        meta: ["写入 index.md 的 ## Rules"],
        input: { placeholder: "一句话说清这条规矩" },
        submitLabel: "添加",
        submit: { name: "abs-panel.rule-add" },
      },
    });
  }

  removeRule(index) {
    this.editRules((text) => rebuildRules(text, (cur) => cur.filter((_, i) => i !== index)));
  }

  addRuleText(rule) {
    const line = String(rule ?? "").trim();
    if (!line) return;
    this.editRules((text) => rebuildRules(text, (cur) => (cur.includes(line) ? cur : [...cur, line])));
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

  // 扫描脚本在哪：mod 可能被装在别的目录名下，挨个试；结果缓存。
  scanScriptCandidates() {
    return [
      `${appHome()}/mods/abs-panel/scripts/scan.js`,
      `${appHome()}/mods/session-panel/scripts/scan.js`,
    ];
  }

  // 读扫描脚本源码（远程要用）。remote 是本机时直接按路径跑，不需要源码。
  loadScript(cx) {
    if (this.loadingScript || this.scriptText) return;
    this.loadingScript = true;
    cx.spawn(async (cx) => {
      try {
        for (const path of this.scanScriptCandidates()) {
          const r = await exec("cat", [path]).catch(() => null);
          if (r?.code === 0 && r.stdout) {
            this.scriptPath = path;
            this.scriptText = r.stdout;
            this.sessRefresh(cx);
            break;
          }
        }
      } finally {
        this.loadingScript = false;
        cx.notify();
      }
    });
  }

  sessCards() {
    const t = theme();
    const list = this.sessVisible();
    // 底色算一次就够，不用每行都算。
    const bg = cardBg(t);
    const body = list.length
      ? list.map((x) => this.sessRow(x, bg))
      : [div().px(6).py(8).text_size(11.5).text_color(t.dim).child("这个文件夹没有会话")];
    return [this.card(this.machine ? `pi 会话 · ${this.machine}` : "pi 会话", list.length, body)];
  }

  sessTargets() {
    const own = this.sessOn();
    const out = [{ on: own }];
    const seen = new Set([own ?? "__local__"]);
    for (const sp of spaces()) {
      const key = sp.machine ?? "__local__";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ on: sp.machine ?? null });
    }
    return out;
  }

  async sessScanOn(on) {
    if (on) {
      if (!this.scriptText) throw new Error("脚本还没读到");
      const r = await exec("sh", ["-c", remoteScanCommand(this.scriptText, LIMIT)], { on });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "扫描失败").trim().slice(0, 160));
      return JSON.parse((r.stdout || "").trim() || "{}").sessions ?? [];
    }
    // 本机没装 node 就跳过，不算错误。探一次就够了，不用每轮都探。
    if (this.hasNode === null) {
      const probe = await exec("sh", ["-c", "command -v node >/dev/null 2>&1 && echo ok || echo missing"]);
      this.hasNode = (probe.stdout || "").trim() === "ok";
    }
    if (!this.hasNode) return [];
    const path = this.scriptPath || this.scanScriptCandidates()[0];
    const r = await exec("node", [path, "--limit", String(LIMIT)]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "扫描失败").trim().slice(0, 160));
    return JSON.parse((r.stdout || "").trim() || "{}").sessions ?? [];
  }

  sessRefresh(cx) {
    // 上一轮还没跑完就跳过。远程扫描要几秒，10 秒定时器很容易叠在一起。
    if (this.scanning) return;
    this.scanning = true;
    const ticket = ++this.scanTicket;
    cx.spawn(async (cx) => {
      const errors = [];
      let got = null;
      try {
        for (const t of this.sessTargets()) {
          try {
            const list = await this.sessScanOn(t.on);
            if (list.length) {
              got = { on: t.on, list };
              break;
            }
          } catch (e) {
            errors.push(String(e?.message || e).slice(0, 80));
          }
        }
        if (ticket !== this.scanTicket) return;
        this.sessions = got?.list ?? [];
        this.machine = got?.on ?? null;
        // 扫到东西就不报错；一条都没扫到才把原因说出来。
        this.error = got ? null : errors.join("；") || null;
      } finally {
        // 不管成没成都要放开，否则一次异常就永远不再扫了。
        this.scanning = false;
        cx.notify();
      }
    });
  }

  sessOn() {
    const space = spaces().find((s) => s.active);
    return space?.machine ?? null;
  }

  sessCwd() {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return norm(pane?.cwd || f?.cwd || space?.folder || home());
  }

  sessResume(s, cx) {
    this.error = null;
    run("pane.split", { direction: "right", argv: ["pi", "--session", s.file || s.id] });
    cx.notify();
  }

  sessRemove(s, cx) {
    if (this.confirmDelete !== s.id) {
      this.confirmDelete = s.id;
      // 5 秒内不再点就自动复位，免得一直挂在「删?」状态误触。
      cx.timer.after(5000, (cx) => {
        if (this.confirmDelete === s.id) {
          this.confirmDelete = null;
          cx.notify();
        }
      });
      cx.notify();
      return;
    }
    this.confirmDelete = null;
    cx.notify();
    const on = this.machine;
    const safe = String(s.file).replace(/'/g, "'\\''");
    const done = (msg) => {
      // 先把结果记下来再刷新，否则 sessRefresh 会把错误覆盖掉。
      if (msg) this.error = msg;
      this.sessRefresh(cx);
    };
    exec("sh", ["-c", `rm -f -- '${safe}'`], on ? { on } : undefined)
      .then(() => done(null))
      .catch((e) => done(`删除失败：${String(e?.message || e).slice(0, 100)}`));
  }

  sessVisible() {
    const here = this.sessCwd();
    return this.sessions.filter((s) => norm(s.cwd) === here);
  }

  sessRow(s, bg) {
    const t = theme();
    const arming = this.confirmDelete === s.id;
    // 标题用会话开头那句，比「当前文件夹」有用。
    const title = s.preview || s.id;
    return v_flex().id(`sess-${s.id}`).w_full().flex_none().gap(3).px(7).py(6).rounded(8)
      .bg(bg).border_1().border_color(arming ? t.ansi1 : t.border).cursor_pointer()
      .hover((el) => el.bg(t.selection))
      .on_click((_e, cx) => this.sessResume(s, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(10).flex_none().text_color(t.dim).child(ago(s.mtime)))
        // 删除按钮：点自己不冒泡到整行的「恢复」
        .child(h_flex().id(`del-${s.id}`).h(16).px(4).flex_none().items_center().rounded(4)
          .bg(arming ? t.ansi1 : t.chrome).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.sessRemove(s, cx); })
          .child(div().text_size(9.5).text_color(arming ? t.background : t.dim).child(arming ? "删?" : "×"))))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(9.5).text_color(t.dim).child(s.id))
        .child(div().text_size(9.5).flex_none().text_color(t.dim).child(sizeText(s.size))));
  }


  render(cx) {
    // 空间/pane 一换，spaces() 和 focused() 变了就会重渲染；这里立刻跟上，不等定时器。
    this.check(this.where(), cx);
    // 改完 index.md 后要刷新，异步回调里拿不到 cx，存一份。
    this.lastCx = cx;
    const t = theme();
    const tab = (id, label) => h_flex().id(`abs-${id}`).h(24).px(9).flex_none().items_center().rounded(6).text_size(11.5)
      .bg(this.view === id ? t.selected : t.chrome).text_color(this.view === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.view = id; cx.notify(); }).child(label);
    // 图谱页把铁律放最上面，下面才是分类索引。
    const body = this.view === "sessions" ? this.sessCards()
      : this.view === "board" ? [this.boardCard(), this.logCard()]
      : this.view === "index" ? [this.rulesCard(), this.indexCard()]
      : [this.logCard(), this.boardCard()];
    return v_flex().id("abs-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(38).flex_none().px(12).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(tab("sessions", "会话")).child(tab("board", "看板")).child(tab("index", "图谱")).child(tab("log", "日志"))
        .child(div().flex_1())
        .child(div().id("abs-refresh").size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            // 会话页刷会话，其他页刷 .brain；两个都刷也不会多花多少。
            this.refresh(cx);
            this.sessRefresh(cx);
          }).child(div().text_size(13).child("↻"))))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().p(10).child(v_flex().gap(10).w_full()
        .when(this.note != null, (e) => e.child(div().px(9).py(7).rounded(8).bg(t.raised).border_1().border_color(t.border).text_size(11).text_color(t.ansi3).child(this.note)))
        .when(this.error != null, (e) => e.child(div().px(9).py(7).rounded(8).bg(t.raised).border_1().border_color(t.ansi1).text_size(11).text_color(t.ansi1).child(this.error)))
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
