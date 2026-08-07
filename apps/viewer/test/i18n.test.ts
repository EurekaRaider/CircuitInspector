import { describe, expect, it } from "vitest";
import { resolveLocale, translate } from "../src/renderer/i18n";

describe("viewer localization", () => {
  it("prefers a persisted supported locale", () => {
    expect(resolveLocale("en-US", "zh-CN")).toBe("en-US");
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("falls back to the browser language", () => {
    expect(resolveLocale(null, "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("unsupported", "fr-FR")).toBe("en-US");
  });

  it("translates interface copy and interpolates values", () => {
    expect(translate("zh-CN", "openDesign")).toBe("打开设计");
    expect(translate("en-US", "layers", { count: 12 })).toBe("12 LAYERS");
  });
});
