// 详情窗：显示一条任务 / 一个图谱页 / 一条日志的全文。
// 由 abs-panel 用 openOverlay 打开。props：
//   title, meta[], body[]    普通详情
//   input, submitLabel, submit  带一个输入框（添加铁律用），送出时把文字交给面板
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

// 极简 markdown 行内处理：`代码`、**加粗**、~~删除线~~ 只去符号留文字，
// 面板里空间小，不为了上样式把字挤掉。
function inlineText(text) {
  return String(text ?? "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
}

export default class AbsDetail extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props() ?? {};
    this.typed = "";
    this.typing = false;
    this.submitting = false;
    this.canCheck = p.canCheck === true;
    if (p.input) {
      this.input = InputState.new({ placeholder: p.input.placeholder ?? "" });
      this.input.on("change", (_e, cx) => { this.typed = this.input.value(); cx.notify(); });
      this.input.on("submit", (_e) => this.submit());
      this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
      cx.timer.after(120, () => this.input.focus());
    }
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

  // 正文按 markdown 显示：标题 / 列表 / 勾选项 / 引用 / 代码块。
  // 勾选行在 canCheck 时可点，点了把这一行的原文交给面板，由面板写回文件。
  markdownRows(body) {
    const t = theme();
    const rows = [];
    let fence = false;
    body.forEach((raw, i) => {
      const line = String(raw ?? "");
      if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return; }
      if (!line.trim()) { rows.push(div().h(4)); return; }
      if (fence) { rows.push(div().w_full().text_size(11.5).text_color(t.dim).child(line)); return; }
      const cb = /^(\s*)[-*+]\s+\[([ xX]?)\]\s*(.*)$/.exec(line);
      if (cb) {
        const done = /x/i.test(cb[2]);
        rows.push(h_flex().id(`abs-detail-cb-${i}`).w_full().gap(6).items_start()
          .when(this.canCheck, (e) => e.cursor_pointer().hover((s0) => s0.text_color(t.foreground)).on_click(() => run(`abs-panel.check:${line}`)))
          .child(div().flex_none().text_size(12).text_color(done ? t.accent : t.muted).child(done ? "☑" : "☐"))
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(done ? t.dim : t.foreground).child(inlineText(cb[3]))));
        return;
      }
      const head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        const size = head[1].length === 1 ? 14 : head[1].length === 2 ? 13 : 12.5;
        rows.push(div().w_full().text_size(size).font_semibold().text_color(t.foreground).child(inlineText(head[2])));
        return;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        rows.push(h_flex().w_full().gap(6).items_start()
          .child(div().flex_none().text_size(12).text_color(t.muted).child("·"))
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(inlineText(bullet[1]))));
        return;
      }
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        rows.push(div().w_full().pl(8).text_size(12.5).text_color(t.dim).child(inlineText(quote[1])));
        return;
      }
      rows.push(div().w_full().text_size(12.5).text_color(t.muted).child(inlineText(line)));
    });
    return rows;
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const meta = (p.meta ?? []).filter(Boolean);
    const body = p.body ?? [];
    const canSubmit = Boolean(p.input) && this.typed.trim().length > 0;
    return v_flex().id("abs-detail").track_focus(this.handle).size_full().min_h(0).p(18).gap(12)
      .bg(t.popover).text_color(t.foreground)
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
      .when(meta.length > 0, (e) => e.child(h_flex().gap(6).flex_none()
        .children(meta.map((m) => div().px(6).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(m)))))
      .when(!p.input, (e) => e.child(div().flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().gap(4).w_full().children(p.markdown ? this.markdownRows(body) : body.map((line) => div().child(line || " "))))))
      .when(Boolean(p.input), (e) => e
        .child(div().id("abs-detail-input").h(36).flex_none().px(10).flex().items_center().rounded(8)
          .border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
        .child(h_flex().justify_end().gap(8).flex_none().text_size(12)
          .child(h_flex().id("abs-detail-cancel").h(30).px(12).items_center().rounded(8).border_1().border_color(t.input)
            .text_color(t.foreground).cursor_pointer().on_click(() => closeOverlay(props().overlay)).child("取消"))
          .child(h_flex().id("abs-detail-submit").h(30).px(14).items_center().rounded(8)
            .bg(canSubmit ? t.solid : t.raised).text_color(canSubmit ? t.solid_foreground : t.dim)
            .when(canSubmit, (x) => x.cursor_pointer()).on_click(() => this.submit())
            .child(p.submitLabel ?? "确定"))));
  }
}
