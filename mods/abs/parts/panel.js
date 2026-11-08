// ABS 记忆库面板：把 .brain 的 index / todo / log 读成三块卡片。
// 目录从当前空间的工作目录往上找 .brain，找不到就用 ~/.brain。
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, readTextFile, writeTextFile, watchFolder, exec, hc, theme, home, run, appHome, openOverlay, nextCommand, shared } from "herdr";

// ── 会话（pi 历史）───────────────────────

const LIMIT = 200;

// 字号：跟左侧栏（side.js / spaces.js 用 12 / 12.5 / 13）对齐，
// 面板正文不再自留小一号。要统一调就改这五个值。
const FS_CARD = 12.5;   // 卡片标题
const FS_ITEM = 12;     // 条目标题（任务、日志、会话、图谱分区）
const FS_BODY = 11.5;   // 正文、空态提示
const FS_META = 10.5;   // 日期、徽章计数、分区标签、分页
const FS_BADGE = 10;    // 带底色的状态徽章（白字）

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
  // 只收「进行中」和「已完成」两段。Done 段的 `### 日期` 只用来给任务带上日期，
  // 不在面板里单独分组显示。
  const out = { doing: [], done: [], doingTitle: "Todo" };
  let group = "";
  let date = "";
  let currentGroup = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ")) {
      const name = line.slice(3).trim();
      currentGroup = null;
      if (name === "Done") group = "done";
      else if (!out.seen) {
        out.seen = true;
        out.doingTitle = name || "Todo";
        group = "doing";
      }
      continue;
    }
    if (line.startsWith("### ")) {
      const name = line.slice(4).trim();
      date = name;
      currentGroup = null;
      continue;
    }
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
    if (!line.startsWith("- ")) continue;
    const task = parseTask(line, group === "doing" ? "doing" : "done");
    if (!task) continue;
    task.date = task.date || date;
    out[task.group].push(task);
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
  // `- [[log-2026-10-30]] 完成任务 1 条`：方括里的是 id，后面才是说明。
  const linked = /^\[\[([^\]]+)\]\]\s*(.*)$/.exec(body);
  if (linked) {
    return {
      group, done: true, state: "", id: linked[1], who: "", date: "",
      title: linked[2] || linked[1], note: "", verdict: "",
      kids: 0, children: [], line: line.trim(),
    };
  }
  const noteAt = body.indexOf(" — ");
  const main = noteAt < 0 ? body : body.slice(0, noteAt);
  const note = noteAt < 0 ? "" : body.slice(noteAt + 3);
  const id = (main.trim().split(/\s+/)[0] || "");
  const who = /\[\[([^\]]+)\]\]/.exec(main)?.[1] ?? "";
  // `(完成 2026-11-02 01a19a68-41a9-71)`：只取日期，后面那串是缓存 id。
  const stamp = /\(认领 ([^)]*)\)/.exec(main)?.[1] ?? /\(完成 ([^)]*)\)/.exec(note)?.[1] ?? "";
  const date = (/\d{4}-\d{2}-\d{2}/.exec(stamp) ?? [""])[0];
  let title = main;
  for (const cut of ["[[", "(认领 "]) {
    const at = title.indexOf(cut);
    if (at >= 0) title = title.slice(0, at);
  }
  title = title.slice(title.indexOf(id) + id.length).trim();
  return { group, done, state, id, who, date, title: title || id, note, verdict: /【([^】]+)】/.exec(note)?.[1] ?? "", kids: 0, children: [], line: line.trim() };
}

// 分区标题是不是「铁律区」。
// 不写死 === "Rules"（2026-11-01 修）：图谱的分区标题可能带计数、emoji、或改成中文，
//   `## Rules（17 条）` / `## ⚖️ Rules` / `## 铁律` 都该认出来。
//   写死的后果：认不出 → 把铁律当普通页统计；rebuildRules 还会再插一个 `## Rules` 造成重复分区。
function isRulesHeading(head) {
  const s = String(head || "");
  return /rules/i.test(s) || s.includes("铁律") || s.includes("硬规则");
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
      // 除了铁律段（单独收成清单），其他 ## 标题一律当分类。
      // 不管叫什么名字、有没有带「（N 页）」计数，都不写死。
      const head = line.slice(3).trim();
      inRules = isRulesHeading(head);
      if (inRules) {
        current = null;
        continue;
      }
      const count = /（\s*(\d+)\s*(?:页|条)?\s*）/.exec(head);
      current = {
        name: count ? head.slice(0, count.index).trim() : head,
        title: head,
        items: [],
        stated: count ? Number(count[1]) : null,
      };
      sections.push(current);
      continue;
    }
    if (!line.startsWith("- ")) continue;
    if (inRules) {
      const t = line.slice(2).trim();
      if (t) rules.push(t);
    } else if (current) {
      const link = /\[\[([^\]]+)\]\]/.exec(line)?.[1];
      const about = line.includes(" — ") ? line.slice(line.indexOf(" — ") + 3).trim() : "";
      current.items.push({ name: link ?? line.slice(2).trim(), about });
    }
  }
  // 空分类也列出来：标题既然写在 index.md 里，就该显示，不能默默吞掉。
  return { sections, rules, ruleCount: rules.length };
}

// 把 index.md 的铁律段换成给定的条目，其余部分原样不动。
// 文件里没有铁律段就补一个（插在第一个二级标题前）。
//
// 不写死 `## Rules`（2026-11-01 修）：原实现用 `l.trim() === "## Rules"` 精确匹配，
//   遇到 `## Rules（17 条）` 这类带计数的标题就认不出 → 走到「补一个」分支，
//   于是文件里出现**两个铁律段**，写入的规则進不了原来那段，人看到的是「写了但没生效」。
//   现在按标题内容识别（isRulesHeading），并保留原有标题文本不动。
function rebuildRules(text, change) {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("## ")) continue;
    if (isRulesHeading(l.slice(3).trim())) { start = i; break; }
  }
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
  // 按时间戳排，新的在前。不能只 reverse：log.md 里的行不保证严格追加，
  // 早先的记录可能写在后面，光反转发会把日期搞乱。
  return out.sort((a, b) => String(b.when).localeCompare(String(a.when)));
}

// ── 面板 ─────────────────────────────────

export default class AbsPanel extends View {
  init(_props, cx) {
    this.brainDir = null;
    this.brainOn = null;
    this.todo = { doing: [], done: [] };
    this.index = { sections: [], rules: [] };
    this.log = [];
    this.logPage = 0;
    this.view = "sessions";
    this.loading = true;
    // 会话页的状态
    this.sessions = [];
    this.machine = null;
    this.confirmDelete = null;
    this.hoveredSess = null;
    this.logOpen = null;   // 展开的日志 id
    this.logTasks = [];    // 它里面的任务
    this.linkedTasks = []; // 所有双链日志里解析出的任务，平铺在已完成里
    this.linkedFor = null; // 已经读过哪一份 todo
    this.linkedLoading = null; // 正在读的那份
    this.boardPage = 0;    // 看板「已完成」翻到第几页
    this.sessPage = 0;     // 会话列表翻到第几页
    this.timerView = null; // 当前给哪一页起着刷新表
    this.stops = [];       // 那些表的 Task，切页时 cancel
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
    this.loadScript(cx);
    this.sessRefresh(cx);
    // 定时器跟着当前面板走，见 syncTimers()。
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
    // 定时器由 syncTimers() 按当前面板启停。
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

  // 只让「当前这一页」定时刷新。切走就停掉，切回来先立刻刷一次再重新起表。
  syncTimers(cx) {
    const view = shared("abs.view") ?? this.view ?? "sessions";
    if (view === this.timerView) return;
    this.timerView = view;

    // 停掉上一页的表（Task.cancel）。
    for (const task of this.stops ?? []) {
      try {
        task?.cancel?.();
      } catch {}
    }
    this.stops = [];

    // 先刷一次，再起 5 秒表。
    this.refresh(cx);
    if (view === "sessions") this.sessRefresh(cx);

    const stops = [];
    if (view === "sessions") {
      stops.push(cx.timer.every(5000, (cx) => this.sessRefresh(cx)));
    } else {
      stops.push(cx.timer.every(5000, (cx) => this.refresh(cx)));
    }
    this.stops = stops.filter(Boolean);
  }

  // 当前该刷哪一页：sessions/board → todo，index → index，log → log。
  // 一次只读一份，别的不碰。读完才替换，失败就保留旧列表（不会变空）。
  wantFile(view) {
    if (view === "index") return "index.md";
    if (view === "log") return "log.md";
    return "todo.md";
  }

  refresh(cx) {
    // 定时器、目录监听、切目录会同时叫；只留最新一轮，旧的结果丢掉。
    const ticket = (this.refreshTicket ?? 0) + 1;
    this.refreshTicket = ticket;
    const at = this.where();
    const context = `${at.on ?? ""}|${at.dir ?? ""}`;
    const view = shared("abs.view") ?? this.view;
    const file = this.wantFile(view);
    if (this.noteKind === "read") this.note = null;

    cx.spawn(async (cx) => {
      try {
        const dir = await this.findBrain(at);
        if (ticket !== this.refreshTicket || context !== this.keyNow()) return;
        this.brainDir = dir;
        this.brainOn = dir ? at.on : null;
        if (dir !== this.watched) this.watched = null;
        this.watch(cx);
        if (!dir) {
          this.loading = false;
          if (this.note == null) { this.note = "没找到 .brain 目录"; this.noteKind = "read"; }
          cx.notify();
          return;
        }
        const text = await readTextFile(`${dir}/${file}`, { on: at.on }).catch(() => null);
        if (ticket !== this.refreshTicket || context !== this.keyNow()) return;

        // 读不到就留着旧数据，不替换成空。
        if (text != null) {
          if (file === "index.md") this.index = parseIndex(text);
          else if (file === "log.md") this.log = parseLog(text);
          else this.todo = parseTodo(text);
          this.note = null;
          this.noteKind = null;
        }
        this.loading = false;
      } catch (e) {
        if (ticket === this.refreshTicket) { this.note = String(e); this.noteKind = "open"; }
        this.loading = false;
      } finally {
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
      // 同一个目录短时间内会反复进来（切页、5 秒表、文件变化都叫 refresh），
      // 每次都从当前目录逐级往上摸一遍太贵：命中过就把答案记住。
      // 失败的不记（目录里后来新建的 .brain 不能被挡住）。
      const hitKey = `${on ?? ""}|${dir}`;
      if (this.brainHit?.key === hitKey) return this.brainHit.dir;
      for (let i = 0; i < 8 && dir && dir !== "/"; i++) {
        const text = await readTextFile(`${dir}/.brain/todo.md`, { on }).catch(() => null);
        if (text !== null) {
          this.brainHit = { key: hitKey, dir: `${dir}/.brain` };
          return this.brainHit.dir;
        }
        const cut = dir.lastIndexOf("/");
        dir = cut <= 0 ? "" : dir.slice(0, cut);
      }
    }
    // 家目录得问那台机器自己：远程的 HOME 往往不是本地那个。问过一次就记住。
    let homeDir = home();
    if (on) {
      const known = (this.remoteHome ?? {})[on];
      if (known) {
        homeDir = known;
      } else {
        const r = await exec("sh", ["-c", "exec printf %s \"$HOME\""], { on }).catch(() => null);
        if (r?.code !== 0 || !r?.stdout.trim()) {
          this.note = `连不上 ${on}，读不到它上面的 .brain`;
          return null;
        }
        homeDir = r.stdout.trim();
        (this.remoteHome ??= {})[on] = homeDir;
      }
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

  // `fill`: the card takes the height it is given and its own body scrolls,
  // instead of the card growing and the panel scrolling as a whole.
  // `fill`: 0 keeps the card as tall as its content; above 0 the card takes
  // that share of the free height and its own body scrolls instead.
  // `footer`: pinned under the scrolling body, so paging stays put.
  card(title, badge, body, fill = 0, footer = null) {
    const t = theme();
    return v_flex().w_full().rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border)
      .when(fill > 0, (e) => e.flex_grow(fill).flex_basis(0).min_h(0), (e) => e.flex_none())
      .child(h_flex().h(32).flex_none().px(9).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(FS_CARD).font_semibold().text_color(t.foreground).child(title))
        .when(badge != null, (e) => e.child(div().px(5).rounded(4).bg(t.chrome).text_size(FS_BADGE).text_color(t.muted).child(String(badge))))
        .child(div().flex_1()))
      .child(
        fill > 0
          ? div().flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().px(4).py(5).gap(6).w_full().children(body))
          : v_flex().px(4).py(5).gap(6).children(body),
      )
      .when(footer != null, (e) => e.child(footer));
  }

  // 三色：绿=进行中，红=暂停（滞留/搁置），橙=完成。
  // 看 checkbox 本身而不是所在区：Done 区里也可能有没做完的 [ ] 行。
  // 圆点颜色：完成=绿，暂停=红，进行中=绿（进行中本来就该是绿的）。
  // 三种卡片（看板任务、图谱分类、日志）都用绿色表示“已完成/正常”，保持一致。
  // 状态标签的底色：进行中=绿，讨论中=橙，滞留/搁置/暂停=红。字都是白的。
  stateBadge(t, state) {
    const s = state ?? "";
    if (/讨论中/.test(s)) return "#e8871e";   // 正橙
    if (/滞留|搁置|暂停/.test(s)) return "#d1495b"; // 红
    if (/进行中/.test(s)) return "#2e7d4f";   // 深绿
    return t.chrome;
  }

  stateColor(task) {
    const t = theme();
    if (task.done) return t.ansi2;
    const paused = /滞留|搁置|讨论中/.test(task.state ?? "");
    return paused ? t.ansi1 : t.ansi2;
  }

  // 点开详情：任务带全文与子项，图谱与日志各自带上自己的正文。
  // 双链 `[[log-YYYY-MM-DD]]` 指向 .brain/sessions/<id>.md：读出任务明细。
  // 看板里的 `[[log-YYYY-MM-DD]]` 双链：把每个 sessions/<id>.md 里的任务都读出来，
  // 平铺进「已完成」，不再只占一行「完成任务 N 条」。
  // 看板里的 `[[log-YYYY-MM-DD]]` 双链：并发读每一份 sessions/<id>.md，解析成任务。
  // 结果按 todo 的链接列表缓存，链接没变就不再读；正在读时也不再起一轮。
  async loadLinked(todo) {
    const links = [...(todo.doing ?? []), ...(todo.done ?? [])]
      .map((x) => x?.id)
      .filter((id) => id && String(id).startsWith("log-"));
    const key = links.join(",");
    if (key === this.linkedFor || key === this.linkedLoading) return;
    if (links.length === 0) {
      this.linkedFor = key;
      this.linkedTasks = [];
      return;
    }

    this.linkedLoading = key;
    const on = this.brainOn;
    const base = this.brainDir || `${home()}/.brain`;
    // 并发读，别一个等一个；远程机器上串行会慢到看得出卡。
    const texts = await Promise.all(
      links.map((id) => readTextFile(`${base}/sessions/${id}.md`, { on }).catch(() => null)),
    );
    this.linkedLoading = null;
    // 读的这一轮已经被更新的一轮取代，结果丢掉。
    if (this.linkedFor === key) return;

    const out = [];
    for (let i = 0; i < links.length; i += 1) {
      const text = texts[i];
      if (!text) continue;
      const parsed = parseTodo(text);
      const fresh = [...parsed.doing, ...parsed.done].filter((x) => x && !String(x.id).startsWith("log-"));
      for (const x of fresh) out.push({ ...x, from: links[i] });
    }
    this.linkedFor = key;
    this.linkedTasks = out;
    this.lastCx?.notify?.();
  }

  // 双链 `[[log-YYYY-MM-DD]]` 指向 .brain/sessions/<id>.md：把里面的任务读出来，
  // 展开在卡片里（再点一次收起），不弹窗。
  async toggleLog(id, cx) {
    if (this.logOpen === id) {
      this.logOpen = null;
      this.logTasks = [];
      cx?.notify?.();
      return;
    }
    this.logOpen = id;
    this.logTasks = [];
    cx?.notify?.();

    const on = this.brainOn;
    const base = this.brainDir || `${home()}/.brain`;
    const text = await readTextFile(`${base}/sessions/${id}.md`, { on }).catch(() => null);
    if (this.logOpen !== id) return;
    const parsed = text ? parseTodo(text) : { doing: [], done: [] };
    this.logTasks = [...parsed.doing, ...parsed.done].filter((x) => x && !String(x.id).startsWith("log-"));
    this.logMissing = text ? null : `${base}/sessions/${id}.md 读不到`;
    cx?.notify?.() ?? this.lastCx?.notify?.();
  }

  openDetail(kind, item) {
    const t = theme();
    if (kind === "task") {
      // `[[log-2026-10-30]]` 这种是双链：去 .brain/sessions 里读那份记录。
      if (item.id && item.id.startsWith("log-")) {
        this.toggleLog(item.id, this.lastCx);
        return;
      }
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
        props: {
          title: item.title || item.name,
          meta: [`${item.items.length} 条`],
          body: item.items.length
            ? item.items.map((x) => `· ${x.name}${x.about ? " — " + x.about : ""}`)
            : ["这个分类下还没有条目。"],
        },
      });
      return;
    }
    openOverlay({
      mod: "abs-detail", kind: "dialog", width: 640, height: 420,
      props: { title: item.text.split("\n")[0] || "(空)", meta: [item.kind, item.when, item.who].filter(Boolean), body: item.text.split("\n") },
    });
  }

  // 一条任务：名字最大，下面是说明；左上角圆点看状态，子项缩进列在下面。
  // 三行：标题 / 描述 / 时间与子项数。子项缩进列在下面。
  // 只有三行：标题 / 描述 / 时间 + 右侧状态与子项数。子项明细点开弹窗看。
  taskRow(task, done = false) {
    const t = theme();
    const dot = done ? t.dim : this.stateColor(task);
    // 描述里去掉【结论】和 (完成 ...) 尾巴，那些已经有自己的位置或不要了。
    const cleanNote = (task.note ?? "")
      .replace(/【[^】]*】/g, "")
      .replace(/\(完成 [^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const detail = cleanNote && cleanNote !== task.title ? cleanNote : "";
    const kids = task.children ?? [];
    return v_flex().w_full().flex_none().gap(3).px(7).py(6).rounded(7).bg(t.raised)
      .cursor_pointer()
      .hover((s) => s.bg(t.chrome))
      .on_click(() => this.openDetail("task", task))
      // 第一行：状态点 + 标题，右侧是状态标签和子项数。
      .child(h_flex().gap(6).items_center()
        .child(div().size(6).flex_none().rounded(3).bg(dot))
        .child(div().flex_1().min_w(0).truncate().text_size(FS_ITEM).font_semibold().text_color(t.foreground).child(task.title))
        .when(Boolean(task.state), (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(this.stateBadge(t, task.state)).text_size(FS_BADGE).text_color("#ffffff").child(task.state))))
      // 第二行：描述，没有就不画这一行
      .when(Boolean(detail), (e) =>
        e.child(div().w_full().min_w(0).truncate().text_size(FS_META).text_color(t.dim).child(detail)),
      )
      // 第三行：只有日期就画，没有就不占位置。
      .when(Boolean(task.date), (e) =>
        e.child(div().w_full().text_size(FS_META).text_color(t.dim).child(task.date)),
      )
      // 子项：在下面按树形列出来，最后一条用 └─。
      .when(kids.length > 0, (e) =>
        e.child(
          v_flex()
            .w_full()
            .mt(2)
            .gap(1)
            .children(
              kids.map((kid, i) =>
                h_flex()
                  .gap(3)
                  .items_center()
                  .child(
                    div()
                      .flex_none()
                      .text_size(FS_META)
                      .text_color(t.dim)
                      .child(`${i === kids.length - 1 ? "└─" : "├─"} ${kid.done ? "☑" : "☐"}`),
                  )
                  .child(div().flex_1().min_w(0).truncate().text_size(FS_META).text_color(kid.done ? t.dim : t.muted).child(kid.text)),
              ),
            ),
        ),
      )
      // 双链展开：把 sessions/<id>.md 里的任务缩进列在下面。
      .when(this.logOpen === task.id, (e) =>
        e.child(
          v_flex()
            .w_full()
            .mt(2)
            .pl(9)
            .gap(2)
            .when(Boolean(this.logMissing), (x) => x.child(div().text_size(FS_META).text_color(t.ansi1).child(this.logMissing)))
            .when(this.logTasks.length === 0 && !this.logMissing, (x) => x.child(div().text_size(FS_META).text_color(t.dim).child("这份记录里没有任务")))
            .children(
              this.logTasks.map((x) =>
                v_flex()
                  .w_full()
                  .gap(1)
                  .child(
                    h_flex()
                      .gap(5)
                      .items_center()
                      .child(div().w(1).h(11).flex_none().rounded(1).bg(x.done ? t.ansi3 : t.border))
                      .child(div().flex_1().min_w(0).truncate().text_size(FS_BODY).text_color(t.muted).child(x.title))
                      .when(Boolean(x.verdict), (el) => el.child(div().text_size(FS_META).text_color(t.dim).child(x.verdict))),
                  )
                  .when(Boolean(x.note && x.note !== x.title), (el) =>
                    el.child(div().pl(6).text_size(FS_META).text_color(t.dim).truncate().child(x.note)),
                  )
                  .children((x.children ?? []).map((k) =>
                    div().pl(6).text_size(FS_META).text_color(t.dim).truncate().child(`${k.done ? "☑" : "☐"} ${k.text}`),
                  )),
              ),
            ),
        ),
      );
  }

  // 看板：只放进行中的任务。徽章和空提示都去掉。
  // 一段小标题：左边名字，右边条数。
  // 看板：一张卡片，进行中和已完成直接排在一起，整张卡片一起滚。
  boardCard(fill = 1) {
    const t = theme();
    const doing = this.todo.doing ?? [];
    // 「完成任务 N 条」这类双链行换成它指向的真实任务：去掉链接行，换成 sessions 里读到的。
    const done = (this.todo.done ?? []).filter((x) => !String(x?.id ?? "").startsWith("log-"));
    const linked = this.linkedTasks ?? [];
    // 异步读，读到后自己 notify；这里不等它，渲染不被它拖住。
    void this.loadLinked(this.todo ?? {});

    const all = [...done, ...linked];
    const PER = 20;
    const pages = Math.max(1, Math.ceil(all.length / PER));
    const page = Math.min(Math.max(0, this.boardPage ?? 0), pages - 1);
    const shown = all.slice(page * PER, page * PER + PER);

    // 翻页条钉在卡片底部，不跟着列表滚。
    const btn = (id, label, to, on) =>
      h_flex()
        .id(id)
        .h(20)
        .px(8)
        .flex_none()
        .items_center()
        .rounded(6)
        .bg(t.chrome)
        .text_color(on ? t.foreground : t.dim)
        .when(on, (x) => x.cursor_pointer().hover((y) => y.bg(t.hover)))
        .on_click((_e, cx) => {
          if (!on) return;
          this.boardPage = to;
          cx.notify();
        })
        .child(div().text_size(FS_META).child(label));
    const footer =
      pages > 1
        ? h_flex()
            .w_full()
            .flex_none()
            .h(32)
            .px(8)
            .gap(8)
            .items_center()
            .justify_center()
            .border_t(1)
            .border_color(t.border)
            .child(btn("abs-board-prev", "‹ Prev", page - 1, page > 0))
            .child(div().text_size(FS_META).text_color(t.muted).child(`${page + 1} / ${pages}`))
            .child(btn("abs-board-next", "Next ›", page + 1, page < pages - 1))
        : null;

    return this.card(
      "看板",
      null,
      [
        ...doing.map((task) => this.taskRow(task)),
        ...shown.map((task) => this.taskRow(task, true)),
        ...(all.length === 0 ? [this.emptyNote(t, "还没有已完成的任务")] : []),
      ],
      fill,
      footer,
    );
  }

  // 卡片里的空提示：占一段高度，文字水平垂直居中。
  emptyNote(t, text) {
    return div().w_full().flex_none().h(64).flex().items_center().justify_center().text_size(FS_BODY).text_color(t.dim).child(text);
  }

  // 最近完成：单独一张卡，与看板并列。
  indexCard() {
    const t = theme();
    // index.md 里出现的每个 ## 分类都列出来，空的也列（显示 0 页），
    // 不按名字排除、也不因没条目就吞掉。
    const sections = this.index.sections ?? [];
    return this.card(
      "图谱索引",
      `${(this.index.sections ?? []).reduce((n, s) => n + (s.items.length || s.stated || 0), 0)} 页`,
      [
        ...(sections.length ? sections.map((s) => h_flex().w_full().flex_none().gap(6).items_center().px(7).py(6).rounded(7)
          .bg(t.raised).cursor_pointer().hover((el) => el.bg(t.chrome))
          .on_click(() => this.openDetail("section", s))
          .child(div().size(7).flex_none().rounded(4).bg(t.ansi6))
          .child(div().flex_1().min_w(0).truncate().text_size(FS_ITEM).font_semibold().text_color(t.foreground).child(s.name))
          .child(div().text_size(FS_META).text_color(t.muted).child(`${s.items.length || s.stated || 0} 页`))) : [div().px(6).text_size(FS_BODY).text_color(t.dim).child("索引为空")]),
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
        ...(shown.length ? shown.map((text, i) => h_flex().w_full().flex_none().gap(6).items_center().px(7).py(6).rounded(7)
          .bg(t.raised).hover((el) => el.bg(t.chrome))
          .child(div().text_size(FS_META).flex_none().text_color(t.ansi6).child(`${i + 1}`))
          .child(div().flex_1().min_w(0).text_size(FS_BODY).text_color(t.foreground).child(text))
          .when(editable, (e) => e.child(div().id(`abs-rule-del-${i}`).size(18).flex_none().flex().items_center().justify_center()
            .rounded(5).text_size(FS_BODY).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.ansi1))
            .on_click(() => this.removeRule(i)).child("×")))) : [div().px(6).text_size(FS_BODY).text_color(t.dim).child("还没有铁律")]),
        ...(hidden > 0 ? [h_flex().id("abs-rule-more").h(22).px(6).flex_none().items_center().text_size(FS_META).text_color(t.dim)
          .cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.rulesOpen = true; cx.notify(); }).child(`还有 ${hidden} 条，展开`)] : []),
        ...(expanded && rules.length > LIMIT ? [h_flex().id("abs-rule-less").h(22).px(6).flex_none().items_center().text_size(FS_META).text_color(t.dim)
          .cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.rulesOpen = false; cx.notify(); }).child("收起")] : []),
        editable
          ? h_flex().id("abs-rule-add").mt(2).h(26).px(8).flex_none().items_center().justify_center().gap(5).rounded(7)
            .text_size(FS_BODY).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.chrome).text_color(t.foreground))
            .on_click(() => this.addRule()).child("+ 添加铁律")
          : div().px(6).text_size(FS_META).text_color(t.dim).child(this.brainOn ? `${this.brainOn} 上的文件改不了，只能看` : "没找到 index.md"),
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

  logCard(fill = 1) {
    const t = theme();
    const all = this.log ?? [];
    const PER = 20;
    const pages = Math.max(1, Math.ceil(all.length / PER));
    const page = Math.min(Math.max(0, this.logPage ?? 0), pages - 1);
    const entries = all.slice(page * PER, page * PER + PER);

    const body = entries.length
      ? entries.map((e) => {
          // 第一行是 `## [时间] [[作者]] 类型 | 正文` 里的正文首句。
          const head = e.text.split("\n")[0] || "(空)";
          const firstStop = head.search(/[。；]/);
          const title = firstStop > 0 ? head.slice(0, firstStop + 1) : head;
          const detail = firstStop > 0 ? head.slice(firstStop + 1).trim() : "";
          return v_flex()
            .w_full()
            .flex_none()
            .gap(3)
            .px(7)
            .py(6)
            .rounded(7)
            .bg(t.raised)
            .cursor_pointer()
            .hover((el) => el.bg(t.chrome))
            .on_click(() => this.openDetail("entry", e))
            // 第一行：标题
            .child(div().w_full().min_w(0).truncate().text_size(FS_ITEM).font_semibold().text_color(t.foreground).child(title))
            // 第二行：详情
            .when(Boolean(detail), (el) =>
              el.child(div().w_full().min_w(0).truncate().text_size(FS_META).text_color(t.dim).child(detail)),
            )
            // 第三行：作者在左，时间在右
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(FS_META).text_color(t.dim).child(e.who || ""))
                .child(div().flex_1())
                .child(div().text_size(FS_META).text_color(t.dim).child(e.when)),
            );
        })
      : [div().w_full().py(10).text_size(FS_BODY).text_color(t.dim).text_center().child("还没有日志")];

    const btn = (id, label, to, on) =>
      h_flex()
        .id(id)
        .h(20)
        .px(8)
        .flex_none()
        .items_center()
        .rounded(6)
        .bg(t.chrome)
        .text_color(on ? t.foreground : t.dim)
        .when(on, (x) => x.cursor_pointer().hover((y) => y.bg(t.hover)))
        .on_click((_e, cx) => {
          if (!on) return;
          this.logPage = to;
          cx.notify();
        })
        .child(div().text_size(FS_META).child(label));

    // 翻页条固定在卡片底部，不跟着列表滚。
    const footer =
      pages > 1
        ? h_flex()
            .w_full()
            .flex_none()
            .h(32)
            .px(8)
            .gap(8)
            .items_center()
            .justify_center()
            .border_t(1)
            .border_color(t.border)
            .child(btn("abs-log-prev", "‹ Prev", page - 1, page > 0))
            .child(div().text_size(FS_META).text_color(t.muted).child(`${page + 1} / ${pages}`))
            .child(btn("abs-log-next", "Next ›", page + 1, page < pages - 1))
        : null;

    return this.card("日志", all.length, body, fill, footer);
  }

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
      `${appHome()}/mods/abs/scripts/scan.js`,
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
    const bg = t.background;

    // 分页：翻页条钉在卡片底部，样式和看板一致。
    const PER = 20;
    const pages = Math.max(1, Math.ceil(list.length / PER));
    const page = Math.min(Math.max(0, this.sessPage ?? 0), pages - 1);
    const shown = list.slice(page * PER, page * PER + PER);

    const body = shown.length
      ? shown.map((x) => this.sessRow(x, bg))
      : [div().px(6).py(8).text_size(FS_BODY).text_color(t.dim).child("这个文件夹没有会话")];

    const btn = (id, label, to, on) =>
      h_flex()
        .id(id)
        .h(20)
        .px(8)
        .flex_none()
        .items_center()
        .rounded(6)
        .bg(t.chrome)
        .text_color(on ? t.foreground : t.dim)
        .when(on, (x) => x.cursor_pointer().hover((y) => y.bg(t.hover)))
        .on_click((_e, cx) => {
          if (!on) return;
          this.sessPage = to;
          cx.notify();
        })
        .child(div().text_size(FS_META).child(label));

    const footer =
      pages > 1
        ? h_flex()
            .w_full()
            .flex_none()
            .h(32)
            .px(8)
            .gap(8)
            .items_center()
            .justify_center()
            .border_t(1)
            .border_color(t.border)
            .child(btn("abs-sess-prev", "‹ Prev", page - 1, page > 0))
            .child(div().text_size(FS_META).text_color(t.muted).child(`${page + 1} / ${pages}`))
            .child(btn("abs-sess-next", "Next ›", page + 1, page < pages - 1))
        : null;

    return [this.card(this.machine ? `pi 会话 · ${this.machine}` : "pi 会话", list.length, body, 1, footer)];
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

  // 和看板/日志的行用同一套尺寸：gap 2 / px 6 / py 5 / rounded 7。
  sessRow(s, bg) {
    const t = theme();
    const arming = this.confirmDelete === s.id;
    const title = s.preview || s.id;
    return v_flex()
      .id(`sess-${s.id}`)
      .relative()
      .w_full()
      .flex_none()
      .gap(3)
      .pl(8)
      .pr(28)
      .py(7)
      .rounded(7)
      .bg(arming ? t.ansi1 : t.raised)
      .cursor_pointer()
      .hover((el) => el.bg(arming ? t.ansi1 : t.chrome))
      .on_hover((h, cx) => {
        const had = this.hoveredSess === s.id;
        if (h) this.hoveredSess = s.id;
        else if (had) this.hoveredSess = null;
        if (had !== h) cx.notify();
      })
      .on_click((_e, cx) => this.sessResume(s, cx))
      .child(div().w_full().min_w(0).truncate().text_size(FS_ITEM).font_semibold().text_color(arming ? t.background : t.foreground).child(title))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().text_size(FS_META).text_color(t.dim).child(ago(s.mtime)))
          .child(div().text_size(FS_META).text_color(t.dim).child(sizeText(s.size))),
      )
      // 删除按钮：平时藏着，鼠标落在这一行时在右侧垂直居中冒出来。无背景、不变色。
      .child(
        div()
          .absolute()
          .right(8)
          .top(0)
          .bottom(0)
          .flex()
          .items_center()
          .child(
            div()
              .id(`del-${s.id}`)
              .opacity(arming || this.hoveredSess === s.id ? 1 : 0)
              .cursor_pointer()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.sessRemove(s, cx);
              })
              .child(div().text_size(FS_ITEM).text_color(arming ? t.background : t.dim).child(arming ? "删?" : "×")),
          ),
      );
  }

  render(cx) {
    // 空间/pane 一换，spaces() 和 focused() 变了就会重渲染；这里立刻跟上，不等定时器。
    this.check(this.where(), cx);
    // 改完 index.md 后要刷新，异步回调里拿不到 cx，存一份。
    this.lastCx = cx;
    const t = theme();
    // 图谱页把铁律放最上面，下面才是分类索引。
    const view = shared("abs.view") ?? this.view;
    // 只为当前这一页起刷新表。
    this.syncTimers(cx);
    // 会话页和看板页的卡片自己滚，外层不再滚。
    const fillsPanel = view === "sessions" || view === "board" || view === "log";
    const body = view === "sessions" ? this.sessCards()
      // 看板：进行中、已完成、日志三张卡片，各自占一份高度、各自在里面滚。
      // 看板：任务卡片按内容高，剩下的高度全给日志。
      // 看板：一张卡片，里面分「进行中」和「已完成」，整张卡片一起滚。
      : view === "board" ? [this.boardCard(1)]
      : view === "index" ? [this.rulesCard(), this.indexCard()]
      : [this.logCard(1)];
    return v_flex().id("abs-panel").size_full().min_h(0).text_color(t.foreground).bg(t.background)
      .child(div().flex_1().min_h(0).p(0).when(fillsPanel, (e) => e.flex(), (e) => e.overflow_y_scrollbar()).child(v_flex().gap(10).w_full().when(fillsPanel, (x) => x.flex_1().min_h(0))
        .when(this.note != null, (e) => e.child(div().px(9).py(7).rounded(8).bg(t.raised).border_1().border_color(t.border).text_size(FS_BODY).text_color(t.ansi3).child(this.note)))
        .when(this.error != null, (e) => e.child(div().px(9).py(7).rounded(8).bg(t.raised).border_1().border_color(t.ansi1).text_size(FS_BODY).text_color(t.ansi1).child(this.error)))
        .children(body)));
  }
}
