/**
 * Delegating-side repo resolver (M9 Unit 6): a {@link RepoResolver} built
 * from `config.repos` (`RepoMapping[]`), the daemon's map from a repoId to
 * ITS OWN local git working copy. `delegate_task` uses it to find the repo to
 * sync BEFORE dispatching a job that names that repoId — a repoId absent
 * here has no local source to sync from, so `delegate_task` fails closed.
 */
import type { RepoMapping } from "../config/config.js";
import type { RepoResolver } from "./tools.js";

/**
 * Builds a `RepoResolver` from the daemon config's repo mappings.
 *
 * `resolveRepoPath(repoId)` returns the mapped local path, or `undefined` when
 * no mapping exists (the caller — `delegate_task` — then fails closed). An
 * empty list therefore always resolves to `undefined`.
 *
 * Duplicate repoIds are rejected upstream at config load (see
 * `ReposConfigSchema`), so they cannot reach here in practice. Defensively,
 * this uses last-wins `Map` semantics: if a duplicate ever did slip through,
 * the LAST entry for a repoId would win. The config refine is the real guard;
 * this note only documents the fallback, it is not a second policy.
 */
export function createRepoResolver(repos: RepoMapping[]): RepoResolver {
  const byRepoId = new Map(repos.map((repo) => [repo.repoId, repo.path]));
  return {
    resolveRepoPath: (repoId: string): string | undefined =>
      byRepoId.get(repoId),
  };
}
