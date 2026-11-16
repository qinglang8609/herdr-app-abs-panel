// ABS 记忆库面板：把 .brain 的 index / todo / log 读成三块卡片。
// 目录从当前空间的工作目录往上找 .brain，找不到就用 ~/.brain。
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, readTextFile, writeTextFile, watchFolder, exec, hc, theme, home, run, appHome, openOverlay, nextCommand, shared } from "herdr";
import Ports from "./ports.js";

// ── 会话（pi 历史）───────────────────────

const LIMIT = 200;
// 一次扫描最多等多久。远程机器连不上时，exec 默认等 30 秒，
// 面板就一直卡着不显示。现在超时就当失败，接着试下一个。
const SCAN_TIMEOUT = 12000;
// 会话和 .brain 的轮询兜底。本机靠 watchFolder 立即刷新，只有远程机器
// 和 watch 失效时才靠这个轮询，所以从 5 秒拉长到 30 秒，不再每 5 秒空转。
const SESS_POLL_MS = 30000;
const BRAIN_POLL_MS = 30000;
// 远程机器上没法监听目录，只能轮询；5 秒才不至于让人觉得「不更新」。
const REMOTE_POLL_MS = 5000;
// 扫到非空结果后，这么久内不再重扫同一台机器（切工作区会强制重扫）。
const SESS_TTL_MS = 25000;

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

// 会话行里的时间：`11-16 10:32`
function whenText(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// token 数：`12.3万` / `1.5亿`
function tokensText(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "…";
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(Math.round(v));
}

// 自带 UTF-8 + base64：这套运行时没有 TextEncoder / btoa。
// node 在哪：从 Finder 启动的 Herdr 只有系统 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// 从终端启动才带 nvm/homebrew 的路径。所以先问 PATH，再按常见安装位置兜一遍。
function nodeSh() {
  return `n=$(command -v node 2>/dev/null); if [ -z "$n" ]; then for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && n="$c" && break; done; fi`;
}

function nodeProbeCommand() {
  return `${nodeSh()}; [ -n "$n" ] && printf '%s' "$n"`;
}

function remoteScanCommand(scriptText, args) {
  // 把脚本原样从 stdin 喂给 node：不写临时文件，不用 base64。
  // 以前用 base64 + mktemp，在部分机器上 sh 会报
  //   /usr/bin/base64: Operation not permitted
  // 同一条命令在别的机器上又正常，干脆不走这条路。
  // 定界符加引号，里面的 $ 和反引号不会被 shell 展开。
  const text = String(scriptText).replace(/\r\n/g, "\n").replace(/\n+$/, "");
  let tag = "__ABS_SCAN_EOF__";
  while (text.includes(tag)) tag += "_";
  return [
    `h=$(uname -n 2>/dev/null)`,
    nodeSh(),
    `[ -n "$n" ] || { echo "没找到 node：$h" >&2; exit 127; }`,
    `"$n" - ${(args ?? []).join(" ")} <<'${tag}'`,
    text,
    tag,
  ].join("\n");
}

// ── 解析 ─────────────────────────────────
//
// 三份文件都按「能认多少认多少」读：某一行写法出乎意料就跳过这一行，
// 不让整块面板变空。以后格式改了也不至于报错。

// 去掉代码块里的内容：``` 包起来的示例行不该被当成任务或日志。
function stripFences(text) {
  const out = [];
  let fence = false;
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue; }
    if (!fence) out.push(line);
  }
  return out;
}

// 括号里的日期：`(认领 2026-11-01 01a1…)`、`(完成 2026-10-22)`、`(2026-11-01)` 都认。
// 不按前缀词匹配，换成别的说法也能取到日期。
function parenDate(text) {
  for (const g of String(text ?? "").match(/\(([^)]*)\)/g) ?? []) {
    const d = /\d{4}-\d{2}-\d{2}/.exec(g);
    if (d) return d[0];
  }
  return "";
}

// checkbox 里的那个字符就是状态：
//   `[ ]` 进行中  `[-]` 滞留中  `[+]` 讨论中  `[x]` 已完成（不再做）  `[~]` 搁置
// 认不出来的字符当「进行中」，不报错。
const MARK_STATE = { "-": "滞留中", "+": "讨论中", "~": "搁置" };
function markState(mark) {
  return MARK_STATE[String(mark ?? "").trim()] ?? "进行中";
}
function markDone(mark) {
  return /x/i.test(String(mark ?? ""));
}

// 分区标题像不像「一个状态名」：进行中 / 讨论中 / 滞留中 都是「≤6 字 + 中」。
// 只看形状，不列具体词，所以「阻塞中」「排队中」也能认。
// 「已完成」不以「中」结尾，不给它挂标签（完成与否已经由圆点和位置表达）。
function stateFromHeading(name) {
  const s = String(name ?? "").trim();
  return /^.{1,6}中$/.test(s) ? s : "";
}

// 分区标题像不像「已完成」。先排掉「未完成」这类含相同词的反义标题。
function isDoneHeading(name) {
  const s = String(name ?? "");
  if (/未完成|未结束|进行中|待办|todo|doing|open|active/i.test(s)) return false;
  return /done|finish|complete|archiv|已完成|完成|归档|结束|关闭|closed/i.test(s);
}

// todo.md 的任务行，写成什么样都尽量认：
//   - [ ] [进行中] id [[作者]] — 标题 (认领 2026-11-01 会话)
//   - [x] id [[作者]] — 标题 — 结语 【落地】 (完成 2026-10-22 会话)
//   - [[log-2026-11-04]] 完成任务 2 条
//   - [ ] 没有 id、没有作者的待办
// 完成与否以 checkbox 为准：`[x]` 算完成，`[ ]` / `[]` 算未完成。
// 只有不写 checkbox 的行才退回看分区标题（Done / 已完成 / 归档 算完成）。
// 状态也一样：行里写了 `[进行中]` 就用行里的，没写就用分区标题（`## 进行中` 这类）。
// strict：会话笔记（sessions/*.md）用。那些文件是散文，随手写的路径行、引用的原话
// 都不该变任务，只有带 checkbox 或带双链的行才算。
function parseTodo(text, strict = false) {
  const out = { doing: [], done: [], doingTitle: "Todo" };
  let sectionDone = false;
  let sectionState = "";
  let date = "";
  let last = null; // 上一条顶层任务，缩进行挂在它下面
  for (const raw of stripFences(text)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      last = null;
      const name = head[2].trim();
      if (head[1].length === 2) {
        // 二级标题才是分区；分区叫什么都行，只看它像不像「已完成」、像不像一个状态。
        if (!out.seen) { out.seen = true; out.doingTitle = name || "Todo"; }
        sectionDone = isDoneHeading(name);
        sectionState = stateFromHeading(name);
      } else if (head[1].length > 2 && /\d/.test(name)) {
        date = name; // `### 2026-11-13` 这类小节标题当日期
      }
      continue;
    }
    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!bullet) continue;
    if (bullet[1].length > 0) {
      // 缩进行是上一条任务的子项。
      if (!last) continue;
      const kid = parseKid(bullet[2], last.done);
      if (kid) { last.kids += 1; last.children.push(kid); }
      continue;
    }
    const task = parseTask(bullet[2], sectionDone, sectionState);
    if (!task) continue;
    if (strict && !task.box && !task.linked) continue;
    task.date = task.date || date;
    task.line = line.trim();
    last = task;
    out[task.group].push(task);
  }
  // 两段都按日期倒排，最新的在上面；没日期的保持文件里的先后。
  const byDate = (a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""));
  out.doing.sort(byDate);
  out.done.sort(byDate);
  return out;
}

// 子项一行：`- [x] 文本`。子项跟父任务用同一套字符：
// `[ ]` 进行中、`[-]` 滞留中、`[+]` 讨论中、`[x]` 已完成、`[~]` 搁置。
// 没写 checkbox 就跟着父任务的状态走。
function parseKid(body, parentDone) {
  let rest = String(body ?? "").trim();
  let done = parentDone === true;
  let mark = "";
  const box = /^\[([ xX+\-~]?)\]\s*/.exec(rest);
  if (box) { mark = box[1].trim(); done = markDone(mark); rest = rest.slice(box[0].length); }
  rest = rest.replace(/\[\[[^\]]+\]\]\s*/g, "").trim();
  return rest ? { text: rest, done, mark } : null;
}

// 看板行里的时间只显示日期：`2026-11-16 11:00` → `2026-11-16`。
function dateOnly(value) {
  const m = /\d{4}-\d{2}-\d{2}/.exec(String(value ?? ""));
  return m ? m[0] : String(value ?? "");
}

// 子项前面那个标记：写了哪种就显示哪种，没写就跟着父任务的完成状态。
function kidMark(kid) {
  if (kid?.mark != null && kid.mark !== "") return `[${kid.mark}]`;
  return kid?.done ? "[x]" : "[ ]";
}

// 子项文字颜色：完成变淡，滞留/搁置变红，其余照常。
function kidColor(t, kid) {
  if (kid?.done) return t.dim;
  if (/[-~]/.test(String(kid?.mark ?? ""))) return t.ansi1;
  return t.muted;
}

// 一条顶层任务。没写 checkbox 时用 fallbackDone（所在分区是不是「已完成」），
// 没写 `[状态]` 时用 fallbackState（`## 进行中` 这类分区标题）。
// 只认**行首连续**的方括号字段：`[时间] [标题] [[作者]] [标签] [会话id]`。
// 正文里再出现的方括号是文字，不当字段。
// 标题里自己也可能带方括号（`整体解析 markdown 的 [] 判断完成与否`），
// 所以单个方括号要按层数找配对的那个，不能遇到第一个 `]` 就收。
function scanFields(text) {
  const fields = [];
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (text[at] !== "[") break;
    if (text[at + 1] === "[") {
      const close = text.indexOf("]]", at + 2);
      if (close < 0) break;
      const inner = text.slice(at + 2, close).trim();
      if (inner) fields.push({ kind: "author", text: inner });
      at = close + 2;
      continue;
    }
    let depth = 0;
    let i = at;
    for (; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]") { depth--; if (depth === 0) break; }
    }
    if (i >= text.length) break; // 没配对：剩下的都当正文
    const inner = text.slice(at + 1, i).trim();
    if (inner) fields.push({ kind: "bracket", text: inner });
    at = i + 1;
  }
  return { fields, rest: text.slice(at).trim() };
}

// 整个方括号就是一个时间戳才算时间字段（`[2026-11-16]`、`[2026-11-16 08:32]`）。
function isTimestampField(text) {
  return /^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?$/.test(String(text ?? "").trim());
}

// 整个方括号就是一串会话 id（`01a1ddf4-c135-72fd-8d4e-bf4ead456730`）。
function isSessionId(text) {
  return /^[0-9a-f]{6,}(?:-[0-9a-f]{2,})+$/i.test(String(text ?? "").trim());
}

// 方括号里那个词是不是状态：进行中 / 讨论中 / 滞留中 / 搁置 / 已完成 这类。
function isStateWord(text) {
  return /^(?:.{1,6}中|搁置|暂停|待办|未开始|未完成|已完成|不再做)$/.test(String(text ?? "").trim());
}

// 一条顶层任务。没写 checkbox 时用 fallbackDone（所在分区是不是「已完成」），
// 没写状态时用 fallbackState（`## 进行中` 这类分区标题）。
function parseTask(body, fallbackDone, fallbackState) {
  let rest = String(body ?? "").trim();
  let done = fallbackDone === true;
  let state = "";
  const box = /^\[([ xX+\-~]?)\]\s*/.exec(rest);
  if (box) {
    const mark = box[1].trim();
    done = markDone(mark);
    // `[ ]` 只说明没做完，不硬当「进行中」：状态留给方括号标签或分区标题。
    state = mark && !done ? markState(mark) : "";
    rest = rest.slice(box[0].length).trim();
  }
  if (!rest) return null;

  const { fields, rest: tail } = scanFields(rest);
  let title = "", date = "", id = "", tagState = "";
  const tags = [];
  const authors = [];
  for (const f of fields) {
    if (f.kind === "author") { authors.push(f.text); continue; }
    const text = f.text;
    // 整个方括号就是时间才算时间字段：`[2026-11-16 08:32]`。
    // 标题里带日期（`[audit-2026-11-16 审查项目]`）不能被当成时间。
    if (isTimestampField(text)) { if (!date) date = text; continue; }
    // 纯会话 id 不占标题位，当标签。
    if (isSessionId(text)) { tags.push(text); continue; }
    // 标题是第一个方括号（旧文件里第一个可能是 `[进行中]` 这种状态词，那只当状态）。
    if (!title) {
      // 第一个方括号是时间，第二个就是标题：整段原样拿来，不剥 id 也不改写。
      if (isStateWord(text)) { if (!tagState) tagState = text; continue; }
      title = text;
      continue;
    }
    // 除标题、时间、作者之外的一律当标签（会话 id 也是标签）。
    tags.push(text);
  }
  const who = authors.find((a) => !a.startsWith("log-")) ?? "";
  const linkId = authors.find((a) => a.startsWith("log-")) ?? "";
  if (tagState && !done) state = tagState;

  // 方括号里有标题：新标准格式，正文（方括号外）剩下的当说明。
  if (title) {
    // `[[log-日期]]` 是完成任务 N 条的汇总行：没写勾也算已完成。
    if (!box && linkId) done = true;
    if (!state && !done) state = fallbackState || "进行中";
    return {
      group: done ? "done" : "doing", done, state, id: id || linkId, who,
      box: Boolean(box), linked: Boolean(linkId) || authors.length > 0,
      date: date || parenDate(rest),
      title, note: tail, tags,
      verdict: /【([^】]+)】/.exec(rest)?.[1] ?? "",
      kids: 0, children: [], line: rest,
    };
  }

  // 没有标题方括号：老格式 `id [[作者]] — 标题 — 结语`，在去掉行首字段之后的那段上读。
  return parseOldTask(tail, done, state, fallbackState, Boolean(box), date, linkId);
}

// 老格式那一套：不再优先，只是留着让旧文件继续能读。
function parseOldTask(rest, done, state, fallbackState, hasBox, date, linkId = "") {
  let body = rest;
  if (!state && !done) state = fallbackState || "进行中";
  // `id [[作者]] — 标题 — 结语`：按破折号切成几段。第一段只有 id 和作者时，标题在第二段。
  const segs = body.split(/\s+[—–]\s+/);
  const main = segs[0] ?? "";
  const tail = segs.slice(1);
  const links = [...main.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  let id = linkId, who = "", title = main;
  if (/^\s*\[\[/.test(main) && links.length) {
    // `- [[log-2026-10-30]] 完成任务 1 条`：方括号里是 id，后面才是说明。
    id = links[0];
    title = main.replace(/^\[\[[^\]]+\]\]\s*/, "").replace(/\[\[[^\]]+\]\]\s*/g, "");
  } else {
    who = links[0] ?? "";
    // 行中间出现的 `[[log-日期]]` 也是双链，不是作者：当 id，作者看后面那个。
    if (who.startsWith("log-")) { id = who; who = links[1] ?? ""; }
    title = main.replace(/\[\[[^\]]+\]\]\s*/g, "");
    // id 只认行首的小写英文短词（面板里的 id 都是这种）；中文、日期、大写开头的整句当标题。
    const tok = /^((?=[a-z0-9._-]*[a-z])[a-z0-9][a-z0-9._-]*)\s+/.exec(title);
    if (tok) { id = tok[1]; title = title.slice(tok[0].length); }
  }
  title = title.replace(/\s+/g, " ").trim();
  let note = tail.join(" — ").trim();
  if (!title && tail.length) {
    // 第一段只有 id 和作者：《标题》在第二段，后面的归说明。
    title = tail[0];
    note = tail.slice(1).join(" — ").trim();
  }
  // 标题尾巴上挂的 `(认领 2026-11-13 sess-1)` 这类时间戳不要。
  title = title.replace(/\s*\([^)]*\d{4}-\d{2}-\d{2}[^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  // `[[log-日期]]` 是完成任务 N 条的汇总行：没写勾也算已完成，也别挂状态标签。
  if (!hasBox && String(id).startsWith("log-")) { done = true; state = ""; }
  return {
    group: done ? "done" : "doing", done, state, id, who,
    box: hasBox, linked: links.length > 0,
    date: date || parenDate(rest),
    title: title || id || "(未命名)", note, tags: [],
    verdict: /【([^】]+)】/.exec(rest)?.[1] ?? "",
    kids: 0, children: [], line: rest,
  };
}

// 分区标题是不是「铁律区」。
// 不写死 === "Rules"（2026-11-01 修）：图谱的分区标题可能带计数、emoji、或改成中文，
//   `## Rules（17 条）` / `## ⚖️ Rules` / `## 铁律` 都该认出来。
//   写死的后果：认不出 → 把铁律当普通页统计；rebuildRules 还会再插一个 `## Rules` 造成重复分区。
function isRulesHeading(head) {
  const s = String(head || "");
  return /rules/i.test(s) || s.includes("铁律") || s.includes("硬规则");
}

// index.md 的分类，形如 `## Concepts` 后若干 `- [[页]] — 一句话`。
// 认得松一点：标题几级都算分类（一级当文件标题跳过），条目符号 - * + 和数字都认，
// 没写在任何标题下面的条目收进「未分类」，不丢。
function parseIndex(text) {
  const sections = [];
  const rules = [];
  let current = null;
  let inRules = false;
  const bucket = () => {
    if (!current) {
      current = { name: "未分类", title: "未分类", items: [], stated: null };
      sections.push(current);
    }
    return current;
  };
  for (const raw of stripFences(text)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const name = head[2].trim();
      if (head[1].length === 1) continue; // 文件标题不是分类
      inRules = isRulesHeading(name);
      if (inRules) { current = null; continue; }
      // 不管叫什么名字、有没有带「（N 页）」计数，都不写死。
      const count = /（\s*(\d+)\s*(?:页|条)?\s*）/.exec(name) ?? /\(\s*(\d+)\s*(?:页|条)?\s*\)/.exec(name);
      current = {
        name: count ? name.slice(0, count.index).trim() : name,
        title: name,
        items: [],
        stated: count ? Number(count[1]) : null,
      };
      sections.push(current);
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!item) continue;
    const body = item[1].trim();
    if (!body) continue;
    if (inRules) { rules.push(body); continue; }
    const link = /\[\[([^\]]+)\]\]/.exec(body)?.[1];
    const cut = /\s+[—–]\s+/.exec(body);
    const about = cut ? body.slice(cut.index + cut[0].length).trim() : "";
    const name = link ?? (cut ? body.slice(0, cut.index).trim() : body);
    bucket().items.push({ name, about });
  }
  // 空分类不显示：分类只来自 index.md 里的 `##` 标题，题下没有条目就不占一行。
  return { sections: sections.filter((s) => s.items.length > 0), rules, ruleCount: rules.length };
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
// 只要求「这行有日期」，其余都能缺：作者没有就留空，竖线没有就整段当正文；
// 标题符号 ## / ###、列表符号 - * + 或数字开头，都认。
function parseLog(text) {
  const out = [];
  for (const raw of stripFences(text)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^#{1,6}\s/.test(line) && !/^(?:[-*+]|\d+[.)])\s/.test(line)) continue;
    const body = line.replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (!body) continue;

    // 新标准行跟 todo 一样：只看行首连续的方括号字段 `[标题] [时间] [[作者]] [标签]`，
    // 正文里的方括号（代码片段之类）不当字段。有标题字段就走新格式，没有退回老格式。
    const { fields, rest: tail } = scanFields(body);
    let when = "", title = "", id = "";
    const tags = [];
    const authors = [];
    for (const f of fields) {
      if (f.kind === "author") { authors.push(f.text); continue; }
      const text = f.text;
      if (isTimestampField(text)) { if (!when) when = text; continue; }
      if (isSessionId(text)) { tags.push(text); continue; }
      if (!title) { title = text; continue; }
      tags.push(text);
    }
    const who = authors.find((a) => !a.startsWith("log-")) ?? "";
    // 没有日期字段时，正文里随便写个日期也算（老列表写法）。
    const looseDate = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/.exec(body);
    const whenAny = when || (looseDate ? (looseDate[2] ? `${looseDate[1]} ${looseDate[2]}` : looseDate[1]) : "");

    if (title) {
      out.push({ when: whenAny, who, kind: "", id, tags, title, text: tail, line: body });
      continue;
    }
    if (!whenAny) continue; // 没有日期的标题只是分节，不是记录

    // 老格式：`## [时间] [[作者]] 类型 | 正文`；日期写在正文里时要先删掉它。
    let text = (when ? tail : tail.replace(looseDate[0], " ")).replace(/^[—–\-|\s]+/, "").replace(/\s+/g, " ").trim();
    let kind = "";
    const bar = text.indexOf("|");
    if (bar > 0) {
      const left = text.slice(0, bar).trim();
      if (left && !/\s/.test(left) && !/^[—–\-]+$/.test(left)) { kind = left; text = text.slice(bar + 1).trim(); }
      else text = text.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
    }
    out.push({ when: whenAny, who, kind, id: "", tags: [], title: "", text, line: body });
  }
  // 按时间戳排，新的在前。不能只 reverse：log.md 里的行不保证严格追加，
  // 早先的记录可能写在后面，光反转发会把日期搞乱。
  return out.sort((a, b) => String(b.when).localeCompare(String(a.when)));
}

// 同一个页面可能来自好几份文件：并成一份。任务按日期倒排，最新的在上面。
function mergeTodo(docs) {
  const out = { doing: [], done: [], doingTitle: "Todo" };
  for (const d of docs) {
    out.doing.push(...(d?.doing ?? []));
    out.done.push(...(d?.done ?? []));
    if (d?.doingTitle && out.doingTitle === "Todo") out.doingTitle = d.doingTitle;
  }
  const byDate = (a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""));
  out.doing.sort(byDate);
  out.done.sort(byDate);
  return out;
}

function mergeLog(lists) {
  return lists.flat().sort((a, b) => String(b.when ?? "").localeCompare(String(a.when ?? "")));
}

// 多份同名文件里取「最近」的那一份：离当前目录层级最浅，同层取路径短的。
// 图谱页用它——只读本项目自己的 index.md，不把子项目的分类和铁律混进来。
function nearestDoc(paths, dir) {
  if (!paths || paths.length <= 1) return paths ?? [];
  const base = dir ? `${String(dir).replace(/\/$/, "")}/` : "";
  const depth = (p) => (base && p.startsWith(base) ? p.slice(base.length).split("/").length : 99);
  return [...paths].sort((a, b) => depth(a) - depth(b) || a.length - b.length).slice(0, 1);
}

function mergeIndex(list) {
  const sections = [];
  const rules = [];
  for (const d of list) {
    for (const s of d?.sections ?? []) {
      const hit = sections.find((x) => x.name === s.name);
      // 同一个分类可能来自好几份 index.md：同名条目只留一条，别把页数算重。
      if (hit) {
        for (const it of s.items) {
          if (hit.seen.has(it.name)) continue;
          hit.seen.add(it.name);
          hit.items.push(it);
        }
      } else {
        sections.push({ ...s, items: [...s.items], seen: new Set(s.items.map((x) => x.name)) });
      }
    }
    for (const r of d?.rules ?? []) if (!rules.includes(r)) rules.push(r);
  }
  // seen 只是合并时用的，不给外面留。
  for (const s of sections) delete s.seen;
  return { sections, rules, ruleCount: rules.length };
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
    // 本机的 node 绝对路径，探一次就够了。
    this.nodeBin = null;
    // 扫描进行中标志，防止定时器和手动刷新叠跑。
    this.scanning = false;
    // 扫描期间又被要求刷一次：跑完再补一轮，别把请求丢在 5 秒里。
    this.scanAgain = false;
    // 每台机器扫到的会话，非空才缓存，别每轮都重扫同一台机器。
    this.sessCache = {};
    // 本机 sessions 目录的监听句柄（见 watchSessions）。
    this.watchedSessions = null;
    // 拼好的远程扫描命令，脚本不变就别每轮都重拼。
    this.remoteCmd = null;
    this.note = null;
    this.watchKey = null;
    // 端口转发页（独立视图，数据不读 .brain）。
    this.ports = new Ports();
    this.ports.init(null, cx);
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
    this.docsStale = true;
    this.refresh(cx);
    // 端口页按服务器取列表，换机器就得立刻跟着换；等 4 秒轮询会看着像卡住。
    this.ports?.refresh(cx);
    // 换了工作区或机器，会话列表也要立刻重扫，不等下一个轮询。
    this.sessRefresh(cx, true);
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

    // 端口页不读 .brain，走自己的刷新（读 ssh config + 探测端口）。
    if (view === "ports") {
      this.ports.refresh(cx);
      this.stops = [cx.timer.every(4000, (cx) => { if (!this.ports.form) this.ports.refresh(cx); })].filter(Boolean);
      return;
    }

    // 先刷一次，再起轮询表。本机靠 watchFolder 立即刷新，这个表只兜底。
    this.refresh(cx);
    if (view === "sessions") this.sessRefresh(cx);

    const stops = [];
    if (view === "sessions") {
      stops.push(cx.timer.every(SESS_POLL_MS, (cx) => this.sessRefresh(cx)));
      this.watchSessions(cx);
    } else {
      // 远程机器没有文件监听，只能轮询：5 秒一轮，改了就能看见；本机有 watchFolder，30 秒兜底就够。
      const every = this.where().on ? REMOTE_POLL_MS : BRAIN_POLL_MS;
      stops.push(cx.timer.every(every, (cx) => this.refresh(cx)));
    }
    this.stops = stops.filter(Boolean);
  }

  // 当前该刷哪一页：sessions/board → todo，index → index，log → log。
  wantKind(view) {
    if (view === "index") return "index";
    if (view === "log") return "log";
    return "todo";
  }

  // 同一个页面可能来自好几份文件：都读、都解析，再并成一份。
  refresh(cx) {
    // 定时器、目录监听、切目录会同时叫；只留最新一轮，旧的结果丢掉。
    const ticket = (this.refreshTicket ?? 0) + 1;
    this.refreshTicket = ticket;
    const at = this.where();
    const context = `${at.on ?? ""}|${at.dir ?? ""}`;
    const view = shared("abs.view") ?? this.view;
    const kind = this.wantKind(view);
    if (this.noteKind === "read") this.note = null;

    cx.spawn(async (cx) => {
      try {
        const docs = await this.findDocs(at);
        if (ticket !== this.refreshTicket || context !== this.keyNow()) return;
        // 看板/日志把目录里找到的都并起来；图谱只取最近的一份 index.md。
        const paths = kind === "index" ? nearestDoc(docs.index, at.dir) : (docs[kind] ?? []);
        const first = [...docs.todo, ...docs.log, ...docs.index][0] ?? null;
        const dir = first ? first.slice(0, first.lastIndexOf("/")) : null;
        this.brainDir = dir;
        this.brainOn = dir ? at.on : null;
        // 每份文件所在目录都监听（本机），并起来的内容才不会漏掉改动。
        this.watchDirs([...docs.todo, ...docs.log, ...docs.index].map((p) => p.slice(0, p.lastIndexOf("/"))), cx);
        if (!paths.length) {
          this.loading = false;
          if (this.note == null) { this.note = `这个目录下没有 ${kind}.md`; this.noteKind = "read"; }
          cx.notify();
          return;
        }
        const texts = await this.readMany(paths, at.on);
        if (ticket !== this.refreshTicket || context !== this.keyNow()) return;

        // 一份都没读到就留着旧数据，不替换成空；读到的几份照常用。
        const read = paths.map((p, i) => ({ path: p, text: texts[i] })).filter((x) => x.text != null);
        if (read.length) {
          if (kind === "index") this.index = mergeIndex(read.map((x) => parseIndex(x.text)));
          else if (kind === "log") this.log = mergeLog(read.map((x) => parseLog(x.text)));
          else {
            const parsed = read.map((x) => {
              const one = parseTodo(x.text);
              for (const t of [...one.doing, ...one.done]) t.src = x.path;
              return one;
            });
            this.todo = mergeTodo(parsed);
            // 双链日志的任务跟着 todo 走：读到了就在这里触发，不在 render 里。
            this.loadLinked(this.todo, cx);
          }
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

  // 读多份文件：本机并行读；远程用一个 exec 全读回来（一个 ssh 连接，不是一个文件一趟）。
  async readMany(paths, on) {
    if (!paths.length) return [];
    if (!on) return Promise.all(paths.map((p) => readTextFile(p, { on }).catch(() => null)));
    const parts = paths.map((p, i) => {
      const q = `'${String(p).replace(/'/g, "'\\''")}'`;
      // \u0001<序号>\u0001 当分隔符：文件内容里不会出现它。
      return `printf '\\001%d\\001' ${i}; cat ${q} 2>/dev/null`;
    });
    const r = await exec("sh", ["-c", parts.join("; ")], { on }).catch(() => null);
    const text = String(r?.stdout ?? "");
    return paths.map((_p, i) => {
      const mark = `\u0001${i}\u0001`;
      const at = text.indexOf(mark);
      if (at < 0) return null;
      const from = at + mark.length;
      const next = text.indexOf(`\u0001${i + 1}\u0001`, from);
      return text.slice(from, next < 0 ? undefined : next);
    });
  }

  keyNow() {
    const at = this.where();
    return `${at.on ?? ""}|${at.dir ?? ""}`;
  }

  // 当前目录下所有 todo.md / log.md / index.md，不分文件夹（不再只认 .brain）。
  // 当前目录里一份都没找到才往上找两级，再没有就用该机器的 ~/.brain。
  // 清单缓存 60 秒：30 秒一轮轮询会反复进来，每轮都跑 find 太贵；
  // 本机目录真有变化时 watch() 会把 docsStale 置上，立刻重扫一次。
  async findDocs(at) {
    const key = `${at.on ?? ""}|${at.dir ?? ""}`;
    const hit = (this.docsCache ?? {})[key];
    // 清单缓存：本机 60 秒（改动由 watch 触发重扫）；远程 20 秒，新建的文件不至于等太久。
    const ttl = at.on ? 20000 : 60000;
    if (hit && !this.docsStale && Date.now() - hit.at < ttl) return hit.docs;

    const docs = { todo: [], log: [], index: [] };
    const take = (paths) => {
      for (const p of paths) {
        const base = String(p).slice(String(p).lastIndexOf("/") + 1).toLowerCase().replace(/\.md$/, "");
        // 每种最多收 8 份：目录里堆了几十份同名文件时，别每轮都读几十遍。
        if (docs[base] && docs[base].length < 8) docs[base].push(p);
      }
    };
    if (at.dir) {
      let dir = at.dir.replace(/\/$/, "");
      for (let i = 0; i < 3 && dir && dir !== "/"; i++) {
        take(await this.findDocsIn(dir, at.on));
        if (docs.todo.length || docs.log.length || docs.index.length) break;
        const cut = dir.lastIndexOf("/");
        dir = cut <= 0 ? "" : dir.slice(0, cut);
      }
    }
    if (!docs.todo.length && !docs.log.length && !docs.index.length) {
      const brain = await this.homeBrain(at);
      if (brain) {
        // 只收读得到的：文件不存在不算错。三份一起问，别一次等一趟（远程尤其明显）。
        const names = ["todo", "log", "index"];
        const texts = await Promise.all(names.map((n) => readTextFile(`${brain}/${n}.md`, { on: at.on }).catch(() => null)));
        names.forEach((n, i) => { if (texts[i] != null) docs[n].push(`${brain}/${n}.md`); });
      }
    }
    this.docsStale = false;
    (this.docsCache ??= {})[key] = { docs, at: Date.now() };
    return docs;
  }

  // 在一个目录里找这三种文件，最多往下 5 层。找不到返回空数组，不报错。
  async findDocsIn(dir, on) {
    const q = `'${String(dir).replace(/'/g, "'\\''")}'`;
    const cmd = `find ${q} -maxdepth 5 -type f \\( -iname todo.md -o -iname log.md -o -iname index.md \\) -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -60`;
    const r = await exec("sh", ["-c", cmd], { on }).catch(() => null);
    return String(r?.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  }

  // 该机器上的 ~/.brain（远程的 HOME 往往不是本地那个，所以去问它自己）。
  async homeBrain(at) {
    const on = at.on;
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
    return `${homeDir}/.brain`;
  }

  // 找到的每份 todo/log/index 所在目录都监听：并起来的东西改了，页面立刻跟着变。
  // 只在本机做；远程机器没法监听目录，靠 30 秒轮询。
  watchDirs(dirs, cx) {
    if (this.brainOn) return;
    this.watchActive ??= {};
    const want = [...new Set(dirs.filter(Boolean))];
    for (const dir of want) {
      if (this.watchActive[dir]) continue;
      this.watchActive[dir] = true;
      cx.spawn(async (cx) => {
        // 目录被删或改名时 watchFolder 会报错。不能就此停掉，停一下接着试。
        while (this.watchActive?.[dir]) {
          let failed = false;
          try {
            await watchFolder(dir);
          } catch {
            failed = true;
          }
          if (!this.watchActive?.[dir]) return;
          if (!failed) {
            // 目录真变了：清单也重扫一次，新建的 todo.md 不用等一分钟。
            this.docsStale = true;
            this.refresh(cx);
            cx.notify();
          }
          if (failed) await new Promise((resolve) => cx.timer.after(5000, resolve));
        }
      });
    }
    for (const dir of Object.keys(this.watchActive)) {
      if (!want.includes(dir)) delete this.watchActive[dir];
    }
  }

  // 本机 pi 会话目录一变就重扫本机，不用等 30 秒轮询。远程机器没这能力。
  watchSessions(cx) {
    const dir = `${home()}/.pi/agent/sessions`;
    if (this.watchedSessions === dir) return;
    this.watchedSessions = dir;
    cx.spawn(async (cx) => {
      while (this.watchedSessions === dir) {
        let failed = false;
        try {
          await watchFolder(dir);
        } catch {
          failed = true;
        }
        if (this.watchedSessions !== dir) return;
        if (!failed) {
          // 本机会话变了：清本机缓存；当前正看本机就立即重扫。
          delete this.sessCache["__local__"];
          if (this.sessOn() === null) this.sessRefresh(cx, true);
          cx.notify();
        }
        if (failed) await new Promise((resolve) => cx.timer.after(10000, resolve));
      }
    });
  }

  // ── 卡片 ───────────────────────────────

  // `fill`: the card takes the height it is given and its own body scrolls,
  // instead of the card growing and the panel scrolling as a whole.
  // `fill`: 0 keeps the card as tall as its content; above 0 the card takes
  // that share of the free height and its own body scrolls instead.
  // `footer`: pinned under the scrolling body, so paging stays put.
  // `gap`: the space between the cards in the body; 0 makes them one flat list.
  card(title, badge, body, fill = 0, footer = null, gap = 6) {
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
          ? div().flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().px(4).py(5).gap(gap).w_full().children(body))
          : v_flex().px(4).py(5).gap(gap).children(body),
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
  async loadLinked(todo, cx) {
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
      const parsed = parseTodo(text, true);
      const fresh = [...parsed.doing, ...parsed.done].filter((x) => x && !String(x.id).startsWith("log-"));
      for (const x of fresh) out.push({ ...x, from: links[i] });
    }
    this.linkedFor = key;
    this.linkedTasks = out;
    cx?.notify?.();
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
    const parsed = text ? parseTodo(text, true) : { doing: [], done: [] };
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
      // 跟行格式同一个顺序：时间 → 作者 → 标签 → 会话 id → 状态/结论。
      const meta = [item.date, item.who, ...(item.tags ?? []), item.id, item.state, item.verdict].filter(Boolean);
      // 详情正文：先父任务那一行原文，再跟着子项（按文件里的缩进和勾选字符写回去）。
      const body = [
        item.line ?? "",
        ...(item.children ?? []).map((k) => `  - [${k.mark || (k.done ? "x" : " ")}] ${k.text}`),
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
            ? item.items.map((x) => `- [[${x.name}]]${x.about ? " — " + x.about : ""}`)
            : ["这个分类下还没有条目。"],
        },
      });
      return;
    }
    openOverlay({
      mod: "abs-detail", kind: "dialog", width: 640, height: 420,
      props: {
        title: item.title || item.text.split("\n")[0] || "(空)",
        meta: [item.when, item.who, ...(item.tags ?? []), item.id, item.kind].filter(Boolean),
        body: [item.line ?? ""],
      },
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
    return v_flex().w_full().flex_none().gap(3).px(7).py(6).rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.chrome))
      .on_click(() => this.openDetail("task", task))
      // 第一行：状态点 + 标题 + 状态徽章。
      .child(h_flex().gap(6).items_center()
        .child(div().size(6).flex_none().rounded(3).bg(dot))
        .child(div().flex_1().min_w(0).truncate().text_size(FS_ITEM).font_semibold().text_color(t.foreground).child(task.title))
        .when(Boolean(task.state), (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(this.stateBadge(t, task.state)).text_size(FS_BADGE).text_color("#ffffff").child(task.state))))
      // 第二行：描述，没有就不画这一行
      .when(Boolean(detail), (e) =>
        e.child(div().w_full().min_w(0).truncate().text_size(FS_META).text_color(t.dim).child(detail)),
      )
      // 第三行：作者在左、时间在右。
      .when(Boolean(task.who) || Boolean(task.date), (e) =>
        e.child(h_flex().w_full().gap(6).items_center()
          .child(div().flex_none().text_size(FS_META).text_color(t.dim).child(task.who || ""))
          .child(div().flex_1())
          .when(Boolean(task.date), (el) => el.child(div().flex_none().text_size(FS_META).text_color(t.dim).child(dateOnly(task.date))))),
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
                      .child(`${i === kids.length - 1 ? "└─" : "├─"} ${kidMark(kid)}`),
                  )
                  .child(div().flex_1().min_w(0).truncate().text_size(FS_META).text_color(kidColor(t, kid)).child(kid.text)),
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
                    div().pl(6).text_size(FS_META).text_color(kidColor(t, k)).truncate().child(`${kidMark(k)} ${k.text}`),
                  )),
              ),
            ),
        ),
      );
  }

  // 看板：一张卡片，不分段、不加小标题，没做完的和做完的按时间混排，最新的在上面。
  // 状态靠圆点颜色和右侧的状态标签区分。
  boardCard(fill = 1) {
    const t = theme();
    const doing = this.todo.doing ?? [];
    // 「完成任务 N 条」这类双链行换成它指向的真实任务：去掉链接行，换成 sessions 里读到的。
    const done = (this.todo.done ?? []).filter((x) => !String(x?.id ?? "").startsWith("log-"));
    const linked = this.linkedTasks ?? [];
    // 进行中的也在这张列表里：不分段，全部按日期倒排，最新的在上面。
    const all = [...doing, ...done, ...linked]
      .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
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
    // 只有一页也照常显示翻页条：页码显示 1，上一页/下一页自己置灰、点不动。
    const footer = h_flex()
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
      .child(btn("abs-board-next", "Next ›", page + 1, page < pages - 1));

    return this.card(
      "看板",
      null,
      [
        ...shown.map((task) => this.taskRow(task, task.done)),
        ...(all.length === 0 ? [this.emptyNote(t, "todo.md 里还没有任务")] : []),
      ],
      fill,
      footer,
      0, // 看板是一整条列表：卡片之间不留空隙
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
          .cursor_pointer().hover((el) => el.bg(t.chrome))
          .on_click(() => this.openDetail("section", s))
          .child(div().size(7).flex_none().rounded(4).bg(t.ansi6))
          .child(div().flex_1().min_w(0).truncate().text_size(FS_ITEM).font_semibold().text_color(t.foreground).child(s.name))
          .child(div().text_size(FS_META).text_color(t.muted).child(`${s.items.length || s.stated || 0} 页`))) : [div().px(6).text_size(FS_BODY).text_color(t.dim).child("索引为空")]),
      ],
      0,
      null,
      0,
    );
  }

  // 铁律卡：图谱顶上的独立一块，能直接改、能加。
  rulesCard() {
    const t = theme();
    // 没有铁律段也照样显示这张卡，只是上面写「还没有铁律」。
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
          .hover((el) => el.bg(t.chrome))
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
      0,
      null,
      0,
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
          // 新格式的标题写在方括号里，正文在方括号外；
          // 老格式（`## [时间] [[作者]] 类型 | 正文`）就从正文里截首句当标题。
          let title = e.title || "";
          let detail = (e.text || "").split("\n")[0];
          if (!title) {
            const head = (e.text || e.kind || e.when || "(空)").split("\n")[0];
            const stop = head.search(/[。；]/);
            title = stop > 0 ? head.slice(0, stop + 1) : head;
            detail = stop > 0 ? head.slice(stop + 1).trim() : "";
          }
          return v_flex()
            .w_full()
            .flex_none()
            .gap(3)
            .px(7)
            .py(6)
            .rounded(7)
            .cursor_pointer()
            .hover((el) => el.bg(t.chrome))
            .on_click(() => this.openDetail("entry", e))
            // 第一行：标题
            .child(div().w_full().min_w(0).truncate().text_size(FS_ITEM).font_semibold().text_color(t.foreground).child(title))
            // 第二行：详情
            .when(Boolean(detail), (el) =>
              el.child(div().w_full().min_w(0).truncate().text_size(FS_META).text_color(t.dim).child(detail)),
            )
            // 第三行：作者在左、时间在右。
            .child(
              h_flex()
                .w_full()
                .gap(6)
                .items_center()
                .child(div().flex_none().text_size(FS_META).text_color(t.dim).child(e.who || ""))
                .child(div().flex_1())
                .child(div().flex_none().text_size(FS_META).text_color(t.dim).child(dateOnly(e.when))),
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

    // 翻页条固定在卡片底部，不跟着列表滚；只有一页也显示（页码 1，两个按钮置灰）。
    const footer = h_flex()
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
      .child(btn("abs-log-next", "Next ›", page + 1, page < pages - 1));

    return this.card("日志", all.length, body, fill, footer, 0);
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

  sessCards(cx) {
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

    // 只有一页也显示翻页条：页码 1，两个按钮置灰。
    const footer = h_flex()
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
      .child(btn("abs-sess-next", "Next ›", page + 1, page < pages - 1));

    // 当前这一页的 token 数，缺的现数
    this.sessTokens(cx, shown);
    return [this.card(this.machine ? `PI会话 · ${this.machine}` : "PI会话", list.length, body, 1, footer, 0)];
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

  // 拼好的远程扫描命令：脚本不变就别每轮都重拼 3.7KB 字符串。
  remoteCmdFor(args) {
    if (this.remoteCmd?.script === this.scriptText) return this.remoteCmd.cmd;
    const cmd = remoteScanCommand(this.scriptText, args ?? ["--limit", String(LIMIT)]);
    this.remoteCmd = { script: this.scriptText, cmd };
    return cmd;
  }

  async sessScanOn(on) {
    if (on) {
      if (!this.scriptText) throw new Error("脚本还没读到");
      const r = await exec("sh", ["-c", this.remoteCmdFor()], { on, timeout: SCAN_TIMEOUT });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "扫描失败").trim().slice(0, 160));
      return JSON.parse((r.stdout || "").trim() || "{}").sessions ?? [];
    }
    // 本机没装 node 就跳过，不算错误。探一次就够了，不用每轮都探。
    if (this.nodeBin === null) {
      const probe = await exec("sh", ["-c", nodeProbeCommand()], { timeout: 8000 });
      this.nodeBin = (probe.stdout || "").trim();
    }
    if (!this.nodeBin) return [];
    const path = this.scriptPath || this.scanScriptCandidates()[0];
    const r = await exec(this.nodeBin, [path, "--limit", String(LIMIT)], { timeout: SCAN_TIMEOUT });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "扫描失败").trim().slice(0, 160));
    return JSON.parse((r.stdout || "").trim() || "{}").sessions ?? [];
  }

  // 数 token：只给当前这一页要显示的会话数（整份读完很贵，不能每轮都扫全部）。
  // 结果按「文件 + mtime」缓存，会话没变就不再数。
  sessTokens(cx, list) {
    if (this.tokenBusy) return;
    const todo = list.filter((x) => x?.file && (!this.tokenCache?.[x.file] || this.tokenCache[x.file].at !== x.mtime));
    if (!todo.length) return;
    this.tokenBusy = true;
    const on = this.machine ?? null;
    cx.spawn(async (cx) => {
      try {
        const files = todo.map((x) => x.file);
        let out = {};
        if (on) {
          if (!this.scriptText) return;
          const args = ["--tokens", ...files.map((f) => `'${String(f).replace(/'/g, "'\\''")}'`)];
          const r = await exec("sh", ["-c", this.remoteCmdFor(args)], { on, timeout: SCAN_TIMEOUT });
          if (r.code === 0) out = JSON.parse((r.stdout || "").trim() || "{}").tokens ?? {};
        } else {
          if (this.nodeBin === null) {
            const probe = await exec("sh", ["-c", nodeProbeCommand()], { timeout: 8000 });
            this.nodeBin = (probe.stdout || "").trim();
          }
          if (!this.nodeBin) return;
          const path = this.scriptPath || this.scanScriptCandidates()[0];
          const r = await exec(this.nodeBin, [path, "--tokens", ...files], { timeout: SCAN_TIMEOUT });
          if (r.code === 0) out = JSON.parse((r.stdout || "").trim() || "{}").tokens ?? {};
        }
        this.tokenCache ??= {};
        for (const x of todo) this.tokenCache[x.file] = { n: Number(out[x.file] ?? 0), at: x.mtime };
      } catch {
        /* 数不出来就不显示，不打断列表 */
      } finally {
        this.tokenBusy = false;
        cx.notify();
      }
    });
  }

  sessRefresh(cx, force = false) {
    // 上一轮还没跑完就记一笔，等它跑完再补一轮。远程扫描要几秒，定时器和
    // 切工作区很容易撞在一起；直接丢掉就是「切了要等下一个轮询」。
    if (this.scanning) {
      this.scanAgain = true;
      return;
    }
    this.scanning = true;
    const ticket = ++this.scanTicket;
    cx.spawn(async (cx) => {
      const errors = [];
      let got = null;
      try {
        for (const t of this.sessTargets()) {
          const key = t.on ?? "__local__";
          const hit = this.sessCache[key];
          // 非空缓存没过期就直接用，别每轮都重扫同一台机器。
          if (!force && hit?.list?.length && Date.now() - hit.at < SESS_TTL_MS) {
            got = { on: t.on, list: hit.list };
            break;
          }
          try {
            const list = await this.sessScanOn(t.on);
            if (list.length) {
              this.sessCache[key] = { list, at: Date.now() };
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
        // 扫到的不是当前机器，说明当前机器那轮出错了，把原因一起带上，
        // 否则界面只显示别的机器的会话，看不出为什么。
        const want = this.sessOn();
        const fell = !!got && (got.on ?? null) !== (want ?? null);
        this.error = got
          ? (fell && errors.length ? `${want ?? "这台机器"}没扫成：${errors[0]}` : null)
          : errors.join("；") || null;
      } finally {
        // 不管成没成都要放开，否则一次异常就永远不再扫了。
        this.scanning = false;
        cx.notify();
        if (this.scanAgain) {
          this.scanAgain = false;
          this.sessRefresh(cx);
        }
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
      // 刚删了文件，强制重扫，别拿缓存里还带着被删会话的旧列表。
      if (msg) this.error = msg;
      this.sessRefresh(cx, true);
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
      // 平时只留正常内边距，不替 × 预留 28px；鼠标落上来时内容整体左移，让出 × 的位置。
      .pr(8)
      .when(arming || this.hoveredSess === s.id, (e) => e.pr(36))
      .py(7)
      .rounded(7)
      .when(arming, (e) => e.bg(t.ansi1))
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
      // 第二行：左边时间，右边 token 数
      .child(
        h_flex()
          .w_full()
          .gap(6)
          .items_center()
          .child(div().text_size(FS_META).text_color(t.dim).child(whenText(s.mtime)))
          .child(div().flex_1())
          .child(div().text_size(FS_META).text_color(t.dim).child(tokensText(this.tokenCache?.[s.file]?.n))),
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
    // 会话页、看板页、日志页、端口页的卡片自己滚，外层不再滚。
    const fillsPanel = view === "sessions" || view === "board" || view === "log" || view === "ports";
    const body = view === "sessions" ? this.sessCards(cx)
      // 看板：进行中、已完成、日志三张卡片，各自占一份高度、各自在里面滚。
      // 看板：任务卡片按内容高，剩下的高度全给日志。
      // 看板：一张卡片，里面分「进行中」和「已完成」，整张卡片一起滚。
      : view === "board" ? [this.boardCard(1)]
      : view === "index" ? [this.rulesCard(), this.indexCard()]
      : view === "ports" ? [this.ports.render(cx)]
      : [this.logCard(1)];
    return v_flex().id("abs-panel").size_full().min_h(0).text_color(t.foreground).bg(t.background)
      .child(div().flex_1().min_h(0).p(0).when(fillsPanel, (e) => e.flex(), (e) => e.overflow_y_scrollbar()).child(v_flex().gap(10).w_full().when(fillsPanel, (x) => x.flex_1().min_h(0))
        .when(this.note != null, (e) => e.child(div().px(9).py(7).rounded(8).bg(t.raised).border_1().border_color(t.border).text_size(FS_BODY).text_color(t.ansi3).child(this.note)))
        .when(this.error != null, (e) => e.child(div().px(9).py(7).rounded(8).bg(t.raised).border_1().border_color(t.ansi1).text_size(FS_BODY).text_color(t.ansi1).child(this.error)))
        .children(body.filter(Boolean))));
  }
}
