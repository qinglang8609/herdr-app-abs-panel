// agent2api：侧栏底部的小统计块，只自己用，跟 abs 完全独立。
// 布局节点写 { mod: "agent2api", props: { part: "stats" } }。

import { View, div } from "gpui-kit";
import { props, theme } from "herdr";
import Stats from "./parts/stats.js";

const PARTS = {
  stats: Stats,
};

export default class Agent2Api extends View {
  init(_props, cx) {
    const Part = PARTS[props()?.part];
    this.part = Part ? new Part() : null;
    if (this.part?.init) {
      if (this.part.init.length >= 2) this.part.init(_props, cx);
      else this.part.init(cx);
    }
  }

  render(cx) {
    if (!this.part) {
      return div()
        .size_full()
        .p(8)
        .text_size(11)
        .text_color(theme().dim)
        .child(`agent2api: 未知的 part "${props()?.part}"`);
    }
    return this.part.render(cx);
  }
}
