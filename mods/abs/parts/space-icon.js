// The icon picker a space's context menu opens: click one to set it. The
// choice lives in shared("space.icons") as { <space id>: <icon name> }, and
// the spaces list reads it back (its own fallback is a per-id glyph).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, setShared, shared, theme } from "herdr";
import { SPACE_ICONS } from "./space-icons.js";

export default class SpaceIcon extends View {
  current() {
    return (shared("space.icons") ?? {})[props()?.id];
  }

  pick(name) {
    const all = { ...(shared("space.icons") ?? {}) };
    if (!name) delete all[props()?.id];
    else all[props()?.id] = name;
    setShared("space.icons", all);
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    const now = this.current();
    return v_flex()
      .id("space-icon")
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(props().overlay);
      })
      .child(
        h_flex()
          .px(8)
          .pt(4)
          .pb(6)
          .text_size(11.5)
          .text_color(t.dim)
          .child("Change icon"),
      )
      .child(
        h_flex()
          .flex_wrap()
          .gap(2)
          .px(4)
          .children(
            SPACE_ICONS.map((name) =>
              h_flex()
                .id(`si-${name}`)
                .size(30)
                .flex_none()
                .rounded(7)
                .items_center()
                .justify_center()
                .cursor_pointer()
                .when(now === name, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.pick(name))
                .child(svg(`mods/abs/icons/${name}.svg`).size(16).text_color(now === name ? t.foreground : t.muted)),
            ),
          ),
      )
      .child(
        h_flex()
          .id("si-auto")
          .mt(2)
          .h(28)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.pick(null))
          .child(div().child("Use the automatic one")),
      );
  }
}
