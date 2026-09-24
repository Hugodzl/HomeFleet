import { expect, test } from "vitest";
import { openUrlCommand } from "./open-url.js";

const URL = "http://127.0.0.1:56373/";

test("windows uses rundll32's URL handler (no cmd.exe parsing of the URL)", () => {
  expect(openUrlCommand(URL, "win32")).toEqual({
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", URL],
  });
});

test("macOS uses open, everything else xdg-open", () => {
  expect(openUrlCommand(URL, "darwin")).toEqual({
    command: "open",
    args: [URL],
  });
  expect(openUrlCommand(URL, "linux")).toEqual({
    command: "xdg-open",
    args: [URL],
  });
});
