import { expect, test } from "bun:test";
import { updateRegistryErrorLabel } from "../src/pages/dashboard-shared";

test("registry diagnostics select localized messages and older servers retain the fallback", () => {
  for (const code of ["network", "timeout", "http", "invalid_response"]) {
    expect(updateRegistryErrorLabel({ code }, key => key)).toBe(`dash.updateRegistry.${code}`);
  }
  expect(updateRegistryErrorLabel(undefined, key => key)).toBe("dash.updateUnavailable");
  expect(updateRegistryErrorLabel({ code: "unknown" }, key => key)).toBe("dash.updateUnavailable");
  expect(updateRegistryErrorLabel({ code: "http", status: 404 }, key => key)).toBe("dash.updateRegistry.not_published");
  expect(updateRegistryErrorLabel({ code: "http", status: 429 }, key => key)).toBe("dash.updateRegistry.rate_limited");
});
