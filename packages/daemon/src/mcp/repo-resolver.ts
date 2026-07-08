/**
 * Delegating-side repo resolver (M9 Unit 6): a {@link RepoResolver} built
 * from `config.repos` (`RepoMapping[]`), the daemon's map from a repoId to
 * ITS OWN local git working copy. `delegate_task` uses it to find the repo to
 * sync BEFORE dispatching a job that names that repoId — a repoId absent
 * here has no local source to sync from, so `delegate_task` fails closed.
 */
import type { RepoMapping } from "../config/config.js";
import type { RepoResolver } from "./tools.js";

/** Builds a `RepoResolver` from the daemon config's repo mappings. */
export function createRepoResolver(repos: RepoMapping[]): RepoResolver {
  const byRepoId = new Map(repos.map((repo) => [repo.repoId, repo.path]));
  return {
    resolveRepoPath: (repoId: string): string | undefined =>
      byRepoId.get(repoId),
  };
}
