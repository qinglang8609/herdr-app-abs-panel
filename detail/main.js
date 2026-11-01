// 详情窗：显示一条任务 / 一个图谱页 / 一条日志的全文。
// 由 abs-panel 用 openOverlay 打开。props：
//   title, meta[], body[]    普通详情
//   input, submitLabel, submit  带一个输入框（添加铁律用），送出时把文字交给面板
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

export default class AbsDetail extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props() ?? {};
    this.typed = "";
    this.typing = false;
    this.submitting = false;
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
        .child(div().id("abs-detail-close").text_size(11).text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => closeOverlay(props().overlay)).child("Esc")))
      .when(meta.length > 0, (e) => e.child(h_flex().gap(6).flex_none()
        .children(meta.map((m) => div().px(6).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(m)))))
      .when(!p.input, (e) => e.child(div().flex_1().min_h(0).overflow_y_scrollbar().text_size(12.5).text_color(t.muted)
        .child(v_flex().gap(6).children(body.map((line) => div().child(line || " "))))))
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
