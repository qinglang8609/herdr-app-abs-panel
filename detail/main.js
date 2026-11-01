// 详情窗：显示一条任务 / 一个图谱页 / 一条日志的全文。
// 由 abs-panel 用 openOverlay 打开，props 传 { title, meta, body }。
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";

export default class AbsDetail extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const meta = (p.meta ?? []).filter(Boolean);
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
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_size(12.5).text_color(t.muted)
        .child(v_flex().gap(6).children((p.body ?? []).map((line) => div().child(line || " ")))));
  }
}
