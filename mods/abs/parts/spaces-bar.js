// The strip above the spaces list, in studio's style: New thread, Search,
// Add machine. The list below stays the shipped spaces mod.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme } from "herdr";
const icon = (name) => `mods/abs/icons/${name}.svg`;

const ROW = 30;

export default class SpacesBar extends View {
  nav(id, name, label, onClick, t) {
    return h_flex()
      .id(id)
      .mx(8)
      .px(10)
      .h(ROW + 2)
      .gap(10)
      .items_center()
      .rounded(8)
      .text_size(13.5)
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(svg(icon(name)).size(16).text_color(t.muted))
      .child(div().flex_1().truncate().child(label));
  }

  render() {
    const t = theme();
    return v_flex()
      .size_full()
      .bg(t.chrome)
      .pt(6)
      .gap(1)
      .child(this.nav("st-new", "square-pen", "New thread", () => run("space.new"), t))
      .child(this.nav("st-search", "search", "Search", () => run("mod.open", { name: "picker" }), t))
      .child(this.nav("st-add-machine", "server", "Add machine", () => run("mod.open", { name: "machine-add" }), t));
  }
}
