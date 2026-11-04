// The sidebar's bottom row: Settings and the light/dark switch. Split out of
// sidebar.js so a layout can place it under any list, the shipped spaces mod
// included.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme } from "herdr";
import { icon, readAppearance, writeAppearance, installThemes, APPEARANCES } from "./lib.js";

const ROW = 30;

export class Footer {
  init(cx) {
    this.appearance = "system";
    this.load(cx);
  }

  async load(cx) {
    try {
      await installThemes();
      this.appearance = await readAppearance();
    } catch {}
    cx.notify();
  }

  async cycleAppearance(cx) {
    const next = APPEARANCES[(APPEARANCES.indexOf(this.appearance) + 1) % APPEARANCES.length];
    this.appearance = next;
    cx.notify();
    try {
      await writeAppearance(next);
      this.appearance = await readAppearance();
    } catch {}
    cx.notify();
  }

  tool(id, name, tip, onClick, t, size = 15) {
    return div()
      .id(id)
      .flex_none()
      .flex()
      .items_center()
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.text_color(t.foreground))
      .tooltip(tip)
      .on_click(onClick)
      .child(svg(icon(name)).size(size));
  }

  render(cx) {
    const t = theme();
    const appearanceIcon = { system: "sun-moon", light: "sun", dark: "moon" }[this.appearance];
    const appearanceLabel = { system: "Theme: System", light: "Theme: Light", dark: "Theme: Dark" }[this.appearance];
    return h_flex()
      .w_full()
      .h(48)
      .px(8)
      .gap(2)
      .items_center()
      .child(
        h_flex()
          .id("st-settings")
          .flex_1()
          .h(ROW + 2)
          .px(10)
          .gap(10)
          .items_center()
          .rounded(8)
          .text_size(13.5)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("app.settings", {}))
          .child(svg(icon("settings")).size(16).text_color(t.muted))
          .child("Settings"),
      )
      .child(this.tool("st-appearance", appearanceIcon, appearanceLabel, (cx) => this.cycleAppearance(cx), t, 16).p(6));
  }
}
