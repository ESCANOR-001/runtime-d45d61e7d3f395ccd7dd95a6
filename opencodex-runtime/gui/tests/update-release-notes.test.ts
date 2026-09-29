import { expect, test } from "bun:test";
import { shouldShowReleaseNotes } from "../src/pages/dashboard-shared";

test("shows release notes for the installed version and older versions", () => {
  expect(shouldShowReleaseNotes("1.0.5", "1.0.5")).toBe(true);
  expect(shouldShowReleaseNotes("1.0.6", "1.0.5")).toBe(true);
});

test("hides a newer version's release notes until it is installed", () => {
  expect(shouldShowReleaseNotes("1.0.4", "1.0.5")).toBe(false);
  expect(shouldShowReleaseNotes("1.0.5-preview.1", "1.0.5")).toBe(false);
});

test("fails closed for malformed versions", () => {
  expect(shouldShowReleaseNotes("dev", "1.0.5")).toBe(false);
  expect(shouldShowReleaseNotes("1.0.5", undefined)).toBe(false);
});
