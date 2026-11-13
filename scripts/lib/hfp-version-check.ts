/**
 * The dependency-free signer (scripts/sign-release.mjs) reads the HFP
 * version from version.ts as TEXT. verify-release re-checks the signed value
 * against the compiled constant, so a misread can never ship.
 */
export function checkSignedHfpVersion(signed: string, source: string): void {
  if (signed !== source) {
    throw new Error(
      `hfpVersion ${signed} in the manifest is not this source's ${source}`,
    );
  }
}
