/**
 * Unit tests for `createRepoResolver`: the delegating-side repoId -> local
 * path lookup `delegate_task` consults before syncing. Pure and synchronous,
 * so these are plain in-process assertions (no daemon, no network).
 */
import { expect, test } from "vitest";
import type { RepoMapping } from "../config/config.js";
import { createRepoResolver } from "./repo-resolver.js";

test("an empty repo list resolves every repoId to undefined", () => {
  const resolver = createRepoResolver([]);
  expect(resolver.resolveRepoPath("anything")).toBeUndefined();
});

test("a single mapping resolves its repoId and nothing else", () => {
  const resolver = createRepoResolver([{ repoId: "repo-a", path: "/src/a" }]);
  expect(resolver.resolveRepoPath("repo-a")).toBe("/src/a");
  // An unmapped id is undefined (the caller then fails closed).
  expect(resolver.resolveRepoPath("repo-b")).toBeUndefined();
});

test("multiple mappings each resolve to their own path", () => {
  const repos: RepoMapping[] = [
    { repoId: "repo-a", path: "/src/a" },
    { repoId: "repo-b", path: "D:/git/b" },
    { repoId: "with/slashes", path: "/src/c" },
  ];
  const resolver = createRepoResolver(repos);
  expect(resolver.resolveRepoPath("repo-a")).toBe("/src/a");
  expect(resolver.resolveRepoPath("repo-b")).toBe("D:/git/b");
  expect(resolver.resolveRepoPath("with/slashes")).toBe("/src/c");
  expect(resolver.resolveRepoPath("missing")).toBeUndefined();
});

test("documented fallback: a duplicate repoId is last-wins (config refine is the real guard)", () => {
  // Config load rejects duplicates (ReposConfigSchema), so this cannot happen
  // in practice; the resolver's own Map-based fallback is last-wins, which we
  // pin here so the documented behavior does not silently change.
  const resolver = createRepoResolver([
    { repoId: "dup", path: "/first" },
    { repoId: "dup", path: "/second" },
  ]);
  expect(resolver.resolveRepoPath("dup")).toBe("/second");
});
