/**
 * Semver string schema, in its own module so both node.ts and upgrade.ts can
 * use it without an import cycle (node.ts embeds upgrade.ts schemas).
 */
import { z } from "zod";

/** Light semver check — enough for v0 version strings like "0.1.0". */
export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a semver string (X.Y.Z)");
