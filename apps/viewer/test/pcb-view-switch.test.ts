import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BoardSideSwitch } from "../src/renderer/PcbWorkspace";

describe("PCB board-side view switch", () => {
  it("renders Top and Bottom as buttons with exactly one active view", () => {
    const markup = renderToStaticMarkup(createElement(BoardSideSwitch, {
      locale: "zh-CN",
      viewSide: "BOTTOM",
      disabled: false,
      onChange: vi.fn()
    }));

    expect(markup).toContain('aria-label="Top 与 Bottom 视图切换"');
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain('data-side="TOP" aria-pressed="false"');
    expect(markup).toContain('data-side="BOTTOM" aria-pressed="true"');
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});
