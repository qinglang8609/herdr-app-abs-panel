// abs：这套界面的一个模块。布局按 part 取不同的块：
//   side-top     侧栏顶栏（设置齿轮 + 折叠）
//   sidebar      侧栏（New thread / Search / Add machine）
//   spaces       工作区列表（按服务器分组）
//   agents       左下 Agents 运行状态
//   header       顶栏（标题、打开按钮、四个页面图标）
//   panel        右侧记忆库面板（会话 / 看板 / 图谱 / 日志）
// 弹窗（不是布局块）：
//   open-menu / quick-open / space-icon
//
// 图标都在 icons/，各块自己不再带图标目录。

import { View, div } from "gpui-kit";
import { props, theme } from "herdr";
import { SideTop, Sidebar } from "./parts/side.js";
import { Header, OpenMenu, QuickOpen } from "./parts/head.js";
import { Footer } from "./parts/foot.js";
import Spaces from "./parts/spaces.js";
import SpacesBar from "./parts/spaces-bar.js";
import Agents from "./parts/agents.js";
import SpaceIcon from "./parts/space-icon.js";
import AbsPanel from "./parts/panel.js";

const PARTS = {
  "side-top": SideTop,
  sidebar: Sidebar,
  "spaces-bar": SpacesBar,
  spaces: Spaces,
  agents: Agents,
  header: Header,
  panel: AbsPanel,
  footer: Footer,
  "open-menu": OpenMenu,
  "quick-open": QuickOpen,
  "space-icon": SpaceIcon,
};

export default class Abs extends View {
  init(_props, cx) {
    const Part = PARTS[props()?.part];
    this.part = Part ? new Part() : null;
    // 各部分的 init 签名不同：有的 (_props, cx)，有的只有 cx。
    // 按声明的参数个数给，别把 cx 当成 _props 传下去。
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
        .text_size(12)
        .text_color(theme().dim)
        .child(`abs: 未知的 part "${props()?.part}"`);
    }
    return this.part.render(cx);
  }
}
