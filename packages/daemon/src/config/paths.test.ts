import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { resolveDataDir } from "./paths.js";

test("HOMEFLEET_DATA_DIR overrides the default on every platform", () => {
  const override = path.join("D:", "custom", "homefleet-data");
  for (const platform of ["win32", "linux", "darwin"] as const) {
    expect(resolveDataDir({ HOMEFLEET_DATA_DIR: override }, platform)).toBe(
      override,
    );
  }
});

test("an empty HOMEFLEET_DATA_DIR is treated as unset", () => {
  const resolved = resolveDataDir({ HOMEFLEET_DATA_DIR: "" }, "linux");
  expect(resolved).toBe(
    path.join(os.homedir(), ".local", "share", "homefleet"),
  );
});

test("win32 default is %LOCALAPPDATA%\\homefleet", () => {
  const localAppData = path.join("C:", "Users", "hugo", "AppData", "Local");
  expect(resolveDataDir({ LOCALAPPDATA: localAppData }, "win32")).toBe(
    path.join(localAppData, "homefleet"),
  );
});

test("win32 falls back to the home directory when LOCALAPPDATA is unset", () => {
  expect(resolveDataDir({}, "win32")).toBe(
    path.join(os.homedir(), "AppData", "Local", "homefleet"),
  );
});

test("linux default is ~/.local/share/homefleet", () => {
  expect(resolveDataDir({}, "linux")).toBe(
    path.join(os.homedir(), ".local", "share", "homefleet"),
  );
});

test("darwin default is ~/Library/Application Support/homefleet", () => {
  expect(resolveDataDir({}, "darwin")).toBe(
    path.join(os.homedir(), "Library", "Application Support", "homefleet"),
  );
});

test("defaults to process.env and process.platform when called bare", () => {
  // Smoke check: resolves to a non-empty absolute-ish path without throwing.
  const resolved = resolveDataDir();
  expect(resolved.length).toBeGreaterThan(0);
  expect(resolved.endsWith("homefleet")).toBe(true);
});
