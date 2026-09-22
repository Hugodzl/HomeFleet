const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Release guard (S1 spec §3): the pushed tag must name exactly the version
 * being packed, so a Release can never carry a mislabeled tarball.
 */
export function checkTagVersion(tag: string, version: string): void {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(`release tag "${tag}" is not of the form v<semver>`);
  }
  if (match[1] !== version) {
    throw new Error(
      `release tag ${tag} does not match @homefleet/daemon version ${version} — bump the version (and DAEMON_VERSION) or fix the tag`,
    );
  }
}
