// 详情窗：显示一条任务 / 一个图谱页 / 一条日志。
// 由 abs-panel 用 openOverlay 打开。props：
//   title, meta[], body[]                  普通详情（纯文本行）
//   input, submitLabel, submit             带一个输入框（添加铁律用），送出时把文字交给面板
//   page: true, path, on, title            图谱页全文：内置编辑器，本机可改、Cmd/Ctrl-S 保存
//
// 关窗确认画在编辑器窗自己里面：Editor 是 retained 原生控件，绘制层级高于普通
// div，app 级对话框也压不住它（试过，字会透过来）；所以确认期间干脆不渲染编辑
// 器（EditorState 还在，取消后原样回来），遮罩用和窗口同色的实色，不再发黑。
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import { props, closeOverlay, run, theme, settings, readTextFile, writeTextFile, notify, exec } from "herdr";

// 远程写文件：writeTextFile 只管本机；远程走 sh + heredoc（base64 在部分机器上被拒，
// 坑见图谱页 herdr-mod-exec-pitfalls）。随机分隔号防正文撞车。
async function shellWrite(path, text, on) {
  const d = "ABS_EOF_" + Math.random().toString(36).slice(2, 10);
  // 先写同目录临时文件再 mv：中途断连不会留下半截文件（mv 同盘是原子的）。
  // heredoc 结束行后面用 ; 接命令，不能用换行后的 &&（那会被当成新命令，语法错误）。
  const r = await exec("sh", ["-c", `t="$1.tmp.$$"; cat > "$t" <<'${d}'\n${text}\n${d}\nrc=$?; if [ "$rc" -eq 0 ]; then mv -f "$t" "$1"; else rm -f "$t"; fi; exit $rc`, "abs-write", path], { on });
  if (!r || r.code !== 0) throw new Error((r?.stderr || "写入失败").trim().slice(0, 120) || "写入失败");
}

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

  // 图谱页：读文件、建编辑器；本机和远程都可编辑，保存分 writeTextFile / heredoc 两条路。
  loadPage(cx) {
    const { path, on } = props() ?? {};
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
        // 代价：改回原样也显示脏，保存一次就好。
        this.code.on("change", () => { if (!this.dirty) { this.dirty = true; cx.notify(); } });
      } catch (e) {
        this.error = String(e);
      } finally {
        cx.notify();
      }
    });
  }

  // 保存：writeTextFile 带 expected 原文，别人先改过就拒绝，不会覆盖。结果走系统弹窗。
  // closeAfter：确认框里的「保存」，写完顺手关窗；失败就留在编辑器里改。
  save(cx, closeAfter = false) {
    if (!this.code || this.saving || this.readonly) return;
    const { path, on } = this.p;
    const text = this.code.value();
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        if (on) {
          // 远程：先重读确认没被别人改过，再走 sh + heredoc 写回。
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

  // 关窗：改过没存先在窗内问一句；确认中再点 × / Esc 等于放弃保存直接关。
  close(cx) {
    if (this.dirty && !this.confirming) {
      this.confirming = true;
      cx.notify();
      return;
    }
    this.code?.release();
    closeOverlay(this.p.overlay);
  }

  // 回给面板：面板收到 rule-add:<文字> 后写 index.md。
  submit() {
    const p = props() ?? {};
    const text = this.typed.trim();
    if (!p.submit || !text || this.submitting) return;
    this.submitting = true;
    closeOverlay(p.overlay);
    run(`${p.submit.name}:${text}`);
  }

  // 关窗确认：不保存 = 直接丢改动退出；取消（Esc / 点遮罩空白）= 回到编辑器。
  // 底下用纯 div 预览文档内容——编辑器此时不渲染，普通元素才能被盒子盖住。
  confirmView(t) {
    const p = this.p;
    const cancel = (_e, cx) => { this.confirming = false; cx.notify(); };
    const discard = () => { this.code?.release(); closeOverlay(p.overlay); };
    return div().absolute().inset_0().flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); cancel(_e, cx); })
      .child(v_flex().w(320).p(18).gap(10).rounded(12).bg(t.background).border_1().border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("有未保存的修改"))
        .child(div().text_size(12).text_color(t.muted).child(`${p.title ?? "这篇文档"} 还没保存。`))
        .child(h_flex().justify_end().gap(8).flex_none()
          .child(h_flex().id("abs-quit-no").h(30).px(12).items_center().rounded(8).border_1().border_color(t.border)
            .text_size(12).text_color(t.foreground).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(discard).child("不保存"))
          .child(h_flex().id("abs-quit-yes").h(30).px(12).items_center().rounded(8).bg(t.solid)
            .text_size(12).text_color(t.solid_foreground).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { this.confirming = false; this.save(cx, true); }).child("保存"))));
  }

  // 确认期间垫在底下的静态预览：让文档不至于凭空消失。纯 div，盖得住。
  // 确认期间垫底的静态预览：只取前 2 万字符，长文档不把几千行都铺出来。
  previewView(t) {
    const text = this.code ? this.code.value() : "";
    const cut = text.length > 20000;
    const lines = (cut ? text.slice(0, 20000) : text).split("\n");
    if (cut && lines.length > 1) lines.pop(); // 丢掉被截断的半行
    return div().flex_1().min_h(0).overflow_y_scrollbar().px(18).py(10).opacity(0.45)
      .child(v_flex().gap(1).w_full().children([
        ...lines.map((line) => div().w_full().text_size(12).text_color(t.muted).child(line || " ")),
        ...(cut ? [div().w_full().text_size(12).text_color(t.dim).child("…")] : []),
      ]));
  }

  render(cx) {
    const t = theme();
    const p = (this.p = props() ?? {});
    const meta = (p.meta ?? []).filter(Boolean);
    const body = p.body ?? [];
    const canSubmit = Boolean(p.input) && this.typed.trim().length > 0;
    const font = this.code ? settings() : null;

    // 图谱页：内置编辑器，能改能存。
    if (p.page) {
      return v_flex().id("abs-detail").track_focus(this.handle).size_full().min_h(0).relative().bg(t.background).text_color(t.foreground)
        .on_key_down((e, cx) => {
          // Cmd/Ctrl-S 保存；Esc 在确认中是「不保存关窗」，平时是关窗（会先确认）。
          if ((e.modifiers.platform || e.modifiers.control) && e.key === "s") {
            // 确认中按 Cmd-S = 保存并关；平时 = 只保存不关。
            if (this.confirming) { this.confirming = false; this.save(cx, true); }
            else this.save(cx);
            cx.stop_propagation();
            return;
          }
          if (e.key === "escape") {
            // 确认中 Esc = 回编辑器（和「点遮罩空白」一个意思）；平时 Esc = 关窗（脏了会先确认）
            if (this.confirming) { this.confirming = false; cx.notify(); }
            else { this.close(cx); }
            cx.stop_propagation();
          }
        })
        .child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(p.title ?? "页面"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(p.path ?? ""))
          .when(this.dirty, (e) => e.child(div().flex_none().size(7).rounded_full().bg(t.ansi1)))
          .child(h_flex().id("abs-detail-close").size(22).flex_none().items_center().justify_center().rounded(6)
            .text_size(15).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .on_click((_e, cx) => this.close(cx)).child("×")))
        // 确认中不渲染编辑器：retained 控件画在一切自绘元素之上，只能请它让位；
        // 底下换成静态预览，文档不至于凭空消失。EditorState 还在，取消后回来。
        .child(
          this.code && !this.confirming
            ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
            : this.confirming
              ? this.previewView(t)
              : div().flex_1().flex().items_center().justify_center().text_size(12).text_color(t.dim)
                .child(this.error || "读取中…"),
        )
        .when(Boolean(this.confirming), (e) => e.child(this.confirmView(t)));
    }

    // 带输入框的表单模式（添加/编辑铁律）：标题、副标题、输入框、按钮，紧凑排列。
    if (p.input) {
      return v_flex().id("abs-detail").track_focus(this.handle).size_full().min_h(0).p(18).gap(12).bg(t.background).text_color(t.foreground)
        .on_key_down((e, cx) => {
          if (e.key === "escape") closeOverlay(props().overlay);
          else return;
          cx.stop_propagation();
        })
        .child(h_flex().gap(10).items_center()
          .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(p.title ?? ""))
          .child(h_flex().id("abs-detail-close").size(22).flex_none().items_center().justify_center().rounded(6)
            .text_size(15).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .on_click(() => closeOverlay(props().overlay)).child("×")))
        .when(meta.length > 0, (e) => e.child(div().w_full().text_size(11.5).text_color(t.muted).child(meta.join(" · "))))
        .child(div().id("abs-detail-input").h(42).flex_none().px(12).flex().items_center().rounded(8)
          .bg(t.raised).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(13).text_color(t.foreground)))
        .child(h_flex().justify_end().gap(8).flex_none().text_size(12)
          .child(h_flex().id("abs-detail-cancel").h(30).px(12).items_center().rounded(8).border_1().border_color(t.border)
            .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click(() => closeOverlay(props().overlay)).child("取消"))
          .child(h_flex().id("abs-detail-submit").h(30).px(14).items_center().rounded(8)
            .bg(canSubmit ? t.solid : t.raised).text_color(canSubmit ? t.solid_foreground : t.dim)
            .when(canSubmit, (x) => x.cursor_pointer().hover((s) => s.bg(t.hover)))
            .on_click(() => this.submit())
            .child(p.submitLabel ?? "确定")));
    }

    // 任务 / 日志详情：和面板行同款格式——状态点、日期、标签行，不再是原文件行。
    if (p.view === "task" || p.view === "log") {
      const isTask = p.view === "task";
      const chips = (isTask
        ? [p.who, ...(p.tags ?? []), p.id, p.state, p.verdict]
        : [p.who, p.kind, ...(p.tags ?? []), p.id]).filter(Boolean);
      const kids = p.kids ?? [];
      const dot = p.dotSolid
        ? div().size(10).flex_none().rounded(5).bg(p.dotColor)
        : div().size(10).flex_none().rounded(5).border_1().border_color(p.dotColor);
      const chipRow = h_flex().gap(6).flex_none().flex_wrap().children(
        chips.map((m) => div().px(6).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(m)));
      const kidRows = kids.map((k) => h_flex().gap(7).items_center()
        .child(div().text_size(11).flex_none().text_color(k.done ? "#4fbf6b" : (k.color || t.dim)).child(k.done ? "✓" : "○"))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(k.done ? t.dim : t.muted).child(k.text)));
      const bodyLines = (p.body ?? []).map((line) => div().w_full().text_size(12.5).text_color(t.muted).child(line || " "));
      const content = v_flex().p(16).pt(14).gap(12).w_full()
        // 任务：状态·结论写在标签行里；日志：类型也在标签行里，不再占状态行
        .when(chips.length > 0, (e) => e.child(chipRow))
        .when(Boolean(isTask && p.note), (e) => e.child(div().w_full().text_size(12.5).text_color(t.muted).child(p.note)))
        .when(Boolean(isTask && kids.length), (e) => e.child(v_flex().gap(4).w_full().pl(2).children(kidRows)))
        .when(Boolean(!isTask), (e) => e.child(v_flex().gap(2).w_full().children(bodyLines)));
      return v_flex().id("abs-detail").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground)
        .on_key_down((e, cx) => {
          if (e.key === "escape") closeOverlay(props().overlay);
          else return;
          cx.stop_propagation();
        })
        .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          // 点 + 标题 + 日期，和面板行同款；类型/状态进下面的标签行
          .child(dot)
          .child(div().flex_none().max_w(360).truncate().text_size(13).font_semibold().text_color(t.foreground).child(p.title ?? ""))
          .child(div().flex_1())
          .child(div().flex_none().text_size(11).text_color(t.dim).child(p.when ?? ""))
          .child(h_flex().id("abs-detail-close").size(24).flex_none().items_center().justify_center().rounded(6)
            .text_size(15).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .on_click(() => closeOverlay(props().overlay)).child("×")))
        .child(div().flex_1().min_h(0).overflow_y_scrollbar().child(content));
    }
  }
}
