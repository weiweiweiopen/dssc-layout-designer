import ts from "typescript";
import appSource from "./App.tsx?raw";
import geometrySource from "./geometry.ts?raw";
import processSource from "./process.ts?raw";
import fabricationSource from "./fabrication-geometry.ts?raw";
import ftoSource from "./fto-connectivity.ts?raw";
import electricalSource from "./electrical.ts?raw";
import pointCodeSource from "./point-code.ts?raw";
import { describe, expect, it } from "vitest";
import { dictionaries, translate } from "./i18n";
import { PARAMETER_HELP } from "./parameter-help";
import { parameterHelpEn, parameterLabelsZh } from "./locales/parameters";
import { staticHelpEn } from "./locales/help";
import { diagnosticText, fixedDiagnostics, resolveDiagnostic } from "./locales/diagnostics";

const han = /[\u3400-\u9fff]/;
const sources: Record<string, string> = {
  "./App.tsx": appSource, "./geometry.ts": geometrySource, "./process.ts": processSource,
  "./fabrication-geometry.ts": fabricationSource, "./fto-connectivity.ts": ftoSource,
  "./electrical.ts": electricalSource, "./point-code.ts": pointCodeSource,
};
function sourceFile(path: string) {
  return ts.createSourceFile(path, sources[path], ts.ScriptTarget.Latest, true,
    path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node); ts.forEachChild(node, (child) => walk(child, visit));
}

describe("built-in Traditional Chinese / English interfaces", () => {
  it("keeps dictionary keys and template parameters in sync", () => {
    expect(Object.keys(dictionaries["zh-TW"]).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const [key, english] of Object.entries(dictionaries.en)) {
      const chinese = dictionaries["zh-TW"][key as keyof typeof dictionaries.en];
      const params = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(chinese.length, key).toBeGreaterThan(0);
      expect(params(chinese), key).toEqual(params(english));
    }
    expect(translate("zh-TW", "sideExposure", { width: "3.00" })).toContain("3.00 mm");
    expect(translate("en", "sideExposure", { width: "3.00" })).toBe("Side exposure 3.00 mm / side");
  });

  it("provides real translated labels and explanatory help for every parameter", () => {
    expect(Object.keys(parameterLabelsZh).sort()).toEqual(Object.keys(PARAMETER_HELP).sort());
    expect(Object.keys(parameterHelpEn).sort()).toEqual(Object.keys(PARAMETER_HELP).sort());
    for (const key of Object.keys(PARAMETER_HELP) as Array<keyof typeof PARAMETER_HELP>) {
      expect(han.test(parameterLabelsZh[key]), key).toBe(true);
      expect(parameterHelpEn[key].length, key).toBeGreaterThan(40);
      expect(han.test(parameterHelpEn[key]), key).toBe(false);
    }
  });

  it("covers static and dynamic JSX tooltip sources, preventing mixed-language fallback", () => {
    walk(sourceFile("./App.tsx"), (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      if (node.tagName.getText() !== "Help") return;
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const content = attributes.find((a) => a.name.getText() === "content")?.initializer;
      const paired = attributes.some((a) => a.name.getText() === "contentEn");
      if (!content || paired) return;
      if (ts.isStringLiteral(content) && han.test(content.text)) {
        expect(staticHelpEn[content.text], content.text).toBeTruthy();
      } else if (ts.isJsxExpression(content) && content.expression && han.test(content.expression.getText())) {
        throw new Error(`Dynamic tooltip lacks English pair: ${content.expression.getText()}`);
      }
    });
  });

  it("localizes all fixed engine diagnostics without altering their canonical sources", () => {
    for (const [code, [zh, en]] of Object.entries(fixedDiagnostics)) {
      expect(resolveDiagnostic(zh).code).toBe(code);
      expect(diagnosticText(zh, "en")).toBe(en);
      expect(diagnosticText(zh, "zh-TW")).toBe(zh);
      expect(han.test(en), code).toBe(false);
    }
    for (const file of ["geometry.ts", "process.ts", "fabrication-geometry.ts", "fto-connectivity.ts", "electrical.ts", "point-code.ts"]) {
      walk(sourceFile(`./${file}`), (node) => {
        if (!ts.isCallExpression(node) || !/^(add|addError)$|(?:errors|issues)\.push$/.test(node.expression.getText())) return;
        for (const arg of node.arguments) {
          if (ts.isStringLiteral(arg) && han.test(arg.text)) {
            expect(resolveDiagnostic(arg.text).code, `${file}: ${arg.text}`).not.toBe("source-message");
          }
        }
      });
    }
  });

  it("retains numerical parameters and stable codes in dynamic warnings", () => {
    const message = "濕膜 10.83 µm 小於假設間隙 15.00 µm：膠量不足，壓合孔寬預測不成立；不可將它解讀成零擴散。";
    const d = resolveDiagnostic(message);
    expect(d.code).toBe("underfill");
    expect(d.params).toEqual(["10.83", "15.00"]);
    expect(diagnosticText(message, "en")).toContain("10.83 µm");
    expect(diagnosticText(message, "en")).toContain("underfill");
    expect(diagnosticText(message, "zh-TW")).toBe(message);
    expect(resolveDiagnostic("glass-6060 有限蝕刻寬度下 cell 11/12 的導通不符合 W 串聯。").params).toEqual(["glass-6060", "11", "12"]);
    expect(diagnosticText("建立製造 SVG：binding-mask.svg", "en")).toBe("Creating fabrication SVG: binding-mask.svg");
  });
});
