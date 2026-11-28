// 详情窗：任务 / 日志 / 图谱页 / 表单 / 确认框 / 右键菜单，六种都从这里出。
// 由 abs-panel / files-mine 用 openOverlay 打开，靠 props 区分：
//   view: "task" | "log"        任务 / 日志详情（面板同款格式）
//   page: true, path, on, title  图谱页全文：内置编辑器，可改可存
//   input, submit{...}           表单（添加/编辑铁律、新建文件、重命名）
//   view: "confirm"              确认框（删除）
//   view: "menu", items          右键菜单
//
// 布局标准（弹窗零件在下面 btnSecondary/btnPrimary/btnClose/dlg* 注释里），
// abs/parts/lib.js 有一份同样的，detail 是独立 mod 不能跨目录 import，两边各带。
//
// 关窗确认画在编辑器窗自己里面：Editor 是 retained 原生控件，绘制层级高于普通
// div，app 级对话框也压不住它（试过，字会透过来）；所以确认期间干脆不渲染编辑
// 器（EditorState 还在，取消后原样回来），底下垫一份静态预览。
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import { props, closeOverlay, run, theme, settings, readTextFile, writeTextFile, notify, exec } from "herdr";

// 远程写文件：writeTextFile 只管本机；远程走 sh + heredoc。
// 先写同目录临时文件再 mv：中途断连不会留下半截文件。heredoc 结束行后面用 ; 接命令，
// 不能用换行后的 &&（那会被当成新命令，语法错误）。
async function shellWrite(path, text, on) {
  const d = "ABS_EOF_" + Math.random().toString(36).slice(2, 10);
  const r = await exec("sh", ["-c", `t="$1.tmp.$$"; cat > "$t" <<'${d}'\n${text}\n${d}\nrc=$?; if [ "$rc" -eq 0 ]; then mv -f "$t" "$1"; else rm -f "$t"; fi; exit $rc`, "abs-write", path], { on });
  if (!r || r.code !== 0) throw new Error((r?.stderr || "写入失败").trim().slice(0, 120) || "写入失败");
}

// ---- 弹窗零件（标准） ------------------------------------------------------
//   外框    p(16) gap(10)，background 底
//   标题    13 半粗
//   关闭 ×  20×20 圆角 5，dim；悬停 raised 底 + foreground
//   输入框  高 30 圆角 7 px 10，透明底 + border 边框；聚焦 accent 边框
//   字段    标签 11 dim 离输入框 5；字段之间 gap 12
//   按钮    高 28 圆角 7：取消 px 12 描边 input；主按钮 px 14 实心 solid（危险 ansi1）
//   按钮行  靠右 gap 8，距内容 10
//   弹窗高度不传，按内容撑。
function btnSecondary(id, label, onClick) {
  const t = theme();
  return h_flex().id(id).h(28).px(12).items_center().rounded(7).border_1().border_color(t.input)
    .text_size(12).text_color(t.foreground).cursor_pointer()
    .hover((s) => s.border_color(t.muted))
    .on_click(onClick).child(label);
}
function btnPrimary(id, label, on, onClick, danger = false) {
  const t = theme();
  return h_flex().id(id).h(28).px(14).items_center().rounded(7).text_size(12)
    .bg(on ? (danger ? t.ansi1 : t.solid) : t.raised)
    .text_color(on ? t.solid_foreground : t.dim)
    .when(on, (x) => x.cursor_pointer().hover((s) => s.opacity(0.82)))
    .on_click((_e, cx) => { if (on) onClick(cx); })
    .child(label);
}
function btnClose(onClick) {
  const t = theme();
  return h_flex().id("abs-detail-close").size(20).flex_none().items_center().justify_center().rounded(5)
    .text_size(14).text_color(t.dim).cursor_pointer()
    .hover((s) => s.bg(t.raised).text_color(t.foreground))
    .on_click(onClick).child("×");
}
// 输入框 / 下拉共用的壳。
function inputShell(t, { typing = false, onClick = null } = {}, ...children) {
  const el = h_flex().h(30).w_full().px(10).items_center().rounded(7).border_1()
    .border_color(typing ? t.accent : t.border)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  if (onClick) el.cursor_pointer().on_click(onClick);
  return el.children(children);
}
function dlgInput(t, state, typing) {
  return inputShell(t, { typing }, Input.new(state).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground));
}
const dlgFooter = (...btns) => h_flex().w_full().flex_none().justify_end().gap(8).mt(4).children(btns.filter(Boolean));

export default class AbsDetail extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = (this.p = props() ?? {});
    this.typed = "";
    this.typing = false;
    this.submitting = false;
    this.code = null;
    this.error = null;
    this.dirty = false;
    this.confirming = false; // 关窗确认挂出来了：这时编辑器先不渲染
    if (p.input) {
      this.input = InputState.new({ placeholder: p.input.placeholder ?? "", value: p.input.value ?? "" });
      this.typed = p.input.value ?? "";
      this.input.on("change", (_e, cx) => { this.typed = this.input.value(); cx.notify(); });
      this.input.on("submit", (_e) => this.submit());
      this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
      cx.timer.after(120, () => this.input.focus());
    }
    if (p.page) this.loadPage(cx);
  }

  // ---- 图谱页 / 文件编辑 ---------------------------------------------------

  // 读文件、建编辑器；本机和远程都可编辑，保存分 writeTextFile / heredoc 两条路。
  loadPage(cx) {
    const { path, on } = this.p;
    if (!path) { this.error = "没有文件路径"; return; }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(path, { on });
        if (text == null) { this.error = `读不到 ${path}`; return; }
        if (text.includes("\0")) { this.error = "二进制文件，看不了"; return; }
        const t = theme();
        this.saved = text;
        // 超过 400KB 的只给看前半截：截断的内容存回去会把后半截丢掉，所以强制只读。
        const truncated = text.length > 400000;
        this.readonly = truncated;
        this.code = EditorState.new({
          language: "markdown",
          readonly: truncated,
          soft_wrap: true,
          value: truncated ? text.slice(0, 400000) + "\n… (文件太长，只读；要改请用外部编辑器)" : text,
          syntax: {
            keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4,
            type: t.ansi3, number: t.ansi1, constant: t.ansi6,
            heading: t.foreground, strong: t.foreground, emphasis: t.muted,
            code: t.ansi2, quote: t.dim, list: t.ansi4, link: t.ansi4,
          },
        });
        // 第一次改动就置脏，不在每次按键里全量取文本比对（大文件每键复制几百 KB）。
        this.code.on("change", () => { if (!this.dirty) { this.dirty = true; cx.notify(); } });
      } catch (e) {
        this.error = String(e);
      } finally {
        cx.notify();
      }
    });
  }

  // 保存。closeAfter：确认框里的「保存」，写完顺手关窗；失败就留在编辑器里改。
  save(cx, closeAfter = false) {
    if (!this.code || this.saving || this.readonly) return;
    const { path, on } = this.p;
    const text = this.code.value();
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        if (on) {
          // 远程：先重读确认没被别人改过，再写回。
          const cur = await readTextFile(path, { on });
          if (cur !== this.saved) throw new Error("文件在远程已被别人改过，保存拒绝");
          await shellWrite(path, text, on);
        } else {
          await writeTextFile(path, text, this.saved);
        }
        this.saved = text;
        this.dirty = false;
        notify({ title: "已保存", body: path.split("/").pop(), level: "success", timeout: 2500 });
        if (closeAfter) { this.code?.release(); closeOverlay(this.p.overlay); return; }
      } catch (e) {
        notify({ title: "保存失败", body: String(e).slice(0, 100), level: "error", timeout: 4000 });
        this.confirming = false;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  // 关窗：改过没存先在窗内问一句。
  close(cx) {
    if (this.dirty && !this.confirming) {
      this.confirming = true;
      cx.notify();
      return;
    }
    this.code?.release();
    closeOverlay(this.p.overlay);
  }

  // ---- 表单 / 菜单 ----------------------------------------------------------

  // 表单回传：<name>:<json{value, ...args}>；没有 args 的（铁律）保持 <name>:<文字>。
  submit() {
    const p = props() ?? {};
    const text = this.typed.trim();
    if (!p.submit || !text || this.submitting) return;
    this.submitting = true;
    closeOverlay(p.overlay);
    if (p.submit.args) run(`${p.submit.name}:${JSON.stringify({ value: text, ...p.submit.args })}`);
    else run(`${p.submit.name}:${text}`);
  }

  // 菜单项被点：关掉菜单，参数塞进命令名（JSON 整段），收方按第一个 : 切开。
  pick(it) {
    if (!it) return;
    closeOverlay(props()?.overlay);
    run(it[2] && Object.keys(it[2]).length ? `${it[1]}:${JSON.stringify(it[2])}` : it[1]);
  }

  // ---- 渲染 ----------------------------------------------------------------

  // 弹窗外框 + 标题栏。rest：后面的元素；onEnter：按回车的动作（没有就只认 Esc）。
  dlg(t, { title, sub, rest = [], onEnter = null }) {
    const close = () => closeOverlay(props().overlay);
    return v_flex().id("abs-detail").track_focus(this.handle).size_full().min_h(0).p(16).gap(10)
      .bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") close();
        else if (e.key === "enter" && onEnter) onEnter(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().h(20).flex_none().w_full().gap(10).items_center()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().w_full().min_w(0).truncate().text_size(13).font_semibold().child(title ?? ""))
          .when(Boolean(sub), (e) => e.child(div().w_full().min_w(0).truncate().text_size(11).text_color(t.muted).child(sub))))
        .child(btnClose(close)))
      .children(rest.filter(Boolean));
  }

  // 关窗确认盒：盖住整个窗，中间一个盒子。底下垫静态预览（纯 div，能被盖住）。
  confirmView(t) {
    const p = this.p;
    const cancel = (_e, cx) => { this.confirming = false; cx.notify(); };
    const discard = () => { this.code?.release(); closeOverlay(p.overlay); };
    return div().absolute().inset_0().flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); cancel(_e, cx); })
      .child(v_flex().w(300).p(16).gap(10).rounded(10).bg(t.background).border_1().border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("有未保存的修改"))
        .child(div().text_size(12).text_color(t.muted).child(`${p.title ?? "这篇文档"} 还没保存。`))
        .child(dlgFooter(
          btnSecondary("abs-quit-no", "不保存", discard),
          btnPrimary("abs-quit-yes", "保存", true, (cx) => { this.confirming = false; this.save(cx, true); }))));
  }

  // 确认期间垫底的静态预览：只取前 2 万字符，长文档不把几千行都铺出来。
  previewView(t) {
    const text = this.code ? this.code.value() : "";
    const cut = text.length > 20000;
    const lines = (cut ? text.slice(0, 20000) : text).split("\n");
    if (cut && lines.length > 1) lines.pop();
    return div().flex_1().min_h(0).overflow_y_scrollbar().px(18).py(10).opacity(0.45)
      .child(v_flex().gap(1).w_full().children([
        ...lines.map((line) => div().w_full().text_size(12).text_color(t.muted).child(line || " ")),
        ...(cut ? [div().w_full().text_size(12).text_color(t.dim).child("…")] : []),
      ]));
  }

  // 右键菜单：打开时不预选；按 ↓ 才从第一项走键盘；鼠标落到哪项键盘光标就跟过去。
  menuView(t, items) {
    return v_flex().id("abs-detail").track_focus(this.handle).w_full().min_h(0).p(5)
      .bg(t.background).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = this.at == null ? 0 : (this.at + 1) % items.length;
        else if (e.key === "up") this.at = this.at == null ? items.length - 1 : (this.at + items.length - 1) % items.length;
        else if (e.key === "enter") { if (this.at != null) this.pick(items[this.at]); return; }
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(items.map((it, i) => h_flex().id(`abs-mi-${i}`).h(28).w_full().px(9).gap(8).items_center().rounded(6)
        .when(this.at === i, (e) => e.bg(t.selected))
        .on_hover((h, cx) => { const was = this.at; this.at = h ? i : (this.at === i ? null : this.at); if (was !== this.at) cx.notify(); })
        .hover((x) => x.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.pick(it))
        .child(div().flex_1().min_w(0).truncate().child(it[0]))));
  }

  render(cx) {
    const t = theme();
    const p = this.p;

    if (p.view === "menu") return this.menuView(t, p.items ?? []);

    if (p.view === "confirm") {
      // 危险操作不给回车快捷键：回车 = 取消，必须鼠标点到红按钮才执行。
      const cancel = () => closeOverlay(p.overlay);
      const go = () => {
        if (this.submitting) return;
        this.submitting = true;
        closeOverlay(p.overlay);
        run(p.submit.args ? `${p.submit.name}:${JSON.stringify(p.submit.args)}` : p.submit.name);
      };
      return this.dlg(t, {
        title: p.title, sub: p.message, onEnter: cancel,
        rest: [dlgFooter(btnSecondary("abs-confirm-cancel", "取消", cancel), btnPrimary("abs-confirm-ok", p.submitLabel ?? "确定", true, go, true))],
      });
    }

    if (p.input) {
      const can = this.typed.trim().length > 0;
      return this.dlg(t, {
        title: p.title, sub: (p.meta ?? []).filter(Boolean).join(" · ") || null,
        rest: [
          dlgInput(t, this.input, this.typing),
          dlgFooter(btnSecondary("abs-detail-cancel", "取消", () => closeOverlay(p.overlay)), btnPrimary("abs-detail-submit", p.submitLabel ?? "确定", can, () => this.submit())),
        ],
      });
    }

    if (p.page) {
      const font = this.code ? settings() : null;
      return v_flex().id("abs-detail").track_focus(this.handle).size_full().min_h(0).relative().bg(t.background).text_color(t.foreground)
        .on_key_down((e, cx) => {
          if ((e.modifiers.platform || e.modifiers.control) && e.key === "s") {
            if (this.confirming) { this.confirming = false; this.save(cx, true); }
            else this.save(cx);
            cx.stop_propagation();
            return;
          }
          if (e.key === "escape") {
            if (this.confirming) { this.confirming = false; cx.notify(); }
            else this.close(cx);
            cx.stop_propagation();
          }
        })
        .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(p.title ?? "页面"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(p.path ?? ""))
          .when(this.dirty, (e) => e.child(div().flex_none().size(7).rounded_full().bg(t.ansi1)))
          .child(h_flex().id("abs-detail-close").size(24).flex_none().items_center().justify_center().rounded(6)
            .text_size(15).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .on_click((_e, cx) => this.close(cx)).child("×")))
        // 确认中不渲染编辑器：retained 控件画在一切自绘元素之上，只能请它让位；
        // 底下换成静态预览。EditorState 还在，取消后回来。
        .child(
          this.code && !this.confirming
            ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
            : this.confirming
              ? this.previewView(t)
              : div().flex_1().flex().items_center().justify_center().text_size(12).text_color(t.dim).child(this.error || "读取中…"),
        )
        .when(Boolean(this.confirming), (e) => e.child(this.confirmView(t)));
    }

    // 任务 / 日志详情：和面板行同款格式。
    if (p.view === "task" || p.view === "log") {
      const isTask = p.view === "task";
      const chips = (isTask ? [p.who, ...(p.tags ?? []), p.id, p.state, p.verdict] : [p.who, p.kind, ...(p.tags ?? []), p.id]).filter(Boolean);
      const dot = p.dotSolid
        ? div().size(10).flex_none().rounded(5).bg(p.dotColor)
        : div().size(10).flex_none().rounded(5).border_1().border_color(p.dotColor);
      const chipRow = h_flex().gap(6).flex_none().flex_wrap().children(
        chips.map((m) => div().px(6).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(m)));
      const kidRows = (p.kids ?? []).map((k) => h_flex().gap(7).items_center()
        .child(div().text_size(11).flex_none().text_color(k.done ? "#4fbf6b" : (k.color || t.dim)).child(k.done ? "✓" : "○"))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(k.done ? t.dim : t.muted).child(k.text)));
      const bodyLines = (p.body ?? []).map((line) => div().w_full().text_size(12.5).text_color(t.muted).child(line || " "));
      const content = v_flex().p(16).pt(14).gap(12).w_full()
        .when(chips.length > 0, (e) => e.child(chipRow))
        .when(Boolean(isTask && p.note), (e) => e.child(div().w_full().text_size(12.5).text_color(t.muted).child(p.note)))
        .when(Boolean(isTask && kidRows.length), (e) => e.child(v_flex().gap(4).w_full().pl(2).children(kidRows)))
        .when(Boolean(!isTask), (e) => e.child(v_flex().gap(2).w_full().children(bodyLines)));
      return v_flex().id("abs-detail").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground)
        .on_key_down((e, cx) => {
          if (e.key === "escape") closeOverlay(p.overlay);
          else return;
          cx.stop_propagation();
        })
        .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(dot)
          .child(div().flex_none().max_w(360).truncate().text_size(13).font_semibold().text_color(t.foreground).child(p.title ?? ""))
          .child(div().flex_1())
          .child(div().flex_none().text_size(11).text_color(t.dim).child(p.when ?? ""))
          .child(h_flex().id("abs-detail-close").size(24).flex_none().items_center().justify_center().rounded(6)
            .text_size(15).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .on_click(() => closeOverlay(p.overlay)).child("×")))
        .child(div().flex_1().min_h(0).overflow_y_scrollbar().child(content));
    }

    return this.dlg(t, { title: p.title, sub: (p.meta ?? []).filter(Boolean).join(" · ") || null, rest: [div().text_size(12.5).text_color(t.muted).child("（空）")] });
  }
}
