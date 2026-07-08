/**
 * `homefleet setup` command generation (M9 Unit 8).
 *
 * This module is PURE: every export builds a shell-command STRING and
 * returns it. Nothing here touches `fs`, `child_process`, or the network —
 * the `setup` CLI prints these strings for Hugo to review and run himself in
 * an elevated PowerShell. That split matters: because a human reads every
 * line before it runs, a wrong-but-plausible command is a review-catchable
 * mistake, whereas a bug in code that RUNS the command directly could firewall
 * a machine wrong or register a task with elevated privileges unattended.
 * Being pure also makes every generator exhaustively unit-testable by exact
 * string comparison (see setup-commands.test.ts) — the tests below double as
 * the spec of what a correct command looks like.
 *
 * Two elevated one-time steps are covered:
 *  - Windows Firewall: two inbound ALLOW rules (HFP TCP, discovery UDP).
 *  - Autostart: an at-logon Task Scheduler task that launches the daemon.
 *
 * WHY `-Profile Private -RemoteAddress LocalSubnet` on the firewall rules:
 * HomeFleet is a LAN-only peer protocol (HFP is mTLS-authenticated, but
 * discovery UDP is not). Scoping the ALLOW rules to the Private profile and
 * to the local subnet means the opened ports are reachable only from other
 * devices on the same home network segment while the adapter is marked
 * Private — never from a public/untrusted network, even if the same
 * physical NIC later joins one. This is defense in depth on top of mTLS,
 * not a substitute for it.
 *
 * WHY the autostart task does NOT run elevated: `homefleetd` binds the HFP
 * and discovery ports (see packages/daemon/src/config/config.ts), both of
 * which default well above 1024, plus loopback-only MCP/control ports. None
 * of that requires administrator rights on Windows — only CREATING the
 * firewall rule does. Running the daemon itself unprivileged means a bug in
 * the daemon cannot leverage elevated rights, so the autostart task is
 * deliberately registered at the caller's normal privilege level (no
 * `/RL HIGHEST`), triggered `ONLOGON` for the current user.
 */

// ---------------------------------------------------------------------------
// Shared quoting / validation helpers.
//
// Every generator below builds a command line that the user will read once
// and then paste, unmodified, into PowerShell. Any interpolated value that
// isn't itself a validated integer MUST be quoted so that a space, quote, or
// control character in it cannot change the shape of the command (or, worst
// case, inject a second command). Fail closed: reject rather than
// best-effort-escape anything we're not confident about.
// ---------------------------------------------------------------------------

/** Matches ASCII control characters (incl. DEL) — never legitimate in a
 * rule name, task name, or filesystem path, and a newline in particular
 * would let an interpolated value smuggle in a second command line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the range is deliberate - this pattern DETECTS control characters to reject.
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

function assertNoControlChars(value: string, label: string): void {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(
      `${label} contains a control character; refusing to build a command from it`,
    );
  }
}

/**
 * Quotes `value` as a PowerShell single-quoted string literal. Single-quoted
 * PowerShell strings are literal (no `$variable` expansion, no backtick
 * escapes to worry about) — the only character that needs escaping is the
 * quote delimiter itself, doubled per PowerShell's own escaping rule.
 */
function quoteForPowerShellSingle(value: string, label: string): string {
  assertNoControlChars(value, label);
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quotes `value` as a double-quoted token (used for `schtasks` arguments,
 * which follow traditional Windows command-line quoting rather than
 * PowerShell's). Rather than implement `"`-escaping (fiddly and easy to get
 * subtly wrong for an infrequently-exercised code path), this REJECTS any
 * embedded `"` outright — Windows filesystem paths and task names can never
 * legitimately contain one (NTFS disallows `"` in file/directory names), so
 * rejecting is both safe and never a real-world false positive.
 */
function quoteForDoubleQuoted(value: string, label: string): string {
  assertNoControlChars(value, label);
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('"')) {
    throw new Error(`${label} must not contain a double-quote character`);
  }
  return `"${value}"`;
}

/**
 * Validates a port per the config schema's own range (see
 * `HfpConfigSchema` / `DiscoveryConfigSchema` in ../config/config.ts), minus
 * the `0` ("bind an ephemeral port") escape hatch those schemas allow for
 * tests: a firewall rule for port `0` is meaningless, so this generator
 * requires a concrete bound port and throws on anything else, including
 * non-finite or non-integer numbers a caller might pass by mistake.
 */
function assertValidPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${label} must be an integer in [1, 65535]; got ${JSON.stringify(port)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Firewall rules.
// ---------------------------------------------------------------------------

/** Default prefix for the firewall `DisplayName`s this module generates. */
export const DEFAULT_RULE_NAME_PREFIX = "HomeFleet";

export type FirewallRuleKind = "hfp-tcp" | "discovery-udp";

/**
 * Builds the stable `DisplayName` for a firewall rule. Add and remove
 * commands both call this, so they always agree on the exact name to
 * create/match — the uninstall path (`generateFirewallRemoveCommands`)
 * removes by `-DisplayName`, so the create and remove commands MUST derive
 * the name identically or the "remove" step would silently no-op.
 */
export function firewallRuleName(
  kind: FirewallRuleKind,
  ruleNamePrefix: string = DEFAULT_RULE_NAME_PREFIX,
): string {
  assertNoControlChars(ruleNamePrefix, "ruleNamePrefix");
  switch (kind) {
    case "hfp-tcp":
      return `${ruleNamePrefix} HFP (TCP)`;
    case "discovery-udp":
      return `${ruleNamePrefix} Discovery (UDP)`;
    default: {
      // Exhaustiveness guard: a new FirewallRuleKind added without a case
      // here is a compile error, not a silent fallthrough at runtime.
      const exhaustive: never = kind;
      throw new Error(`Unknown firewall rule kind: ${String(exhaustive)}`);
    }
  }
}

export interface FirewallPortOptions {
  /** The HFP mTLS port (see `HfpConfig.port`, default `HFP_DEFAULT_PORT`). */
  hfpPort: number;
  /** The UDP discovery port (see `DiscoveryConfig.udpPort`). */
  udpPort: number;
  ruleNamePrefix?: string;
}

/**
 * Builds two `New-NetFirewallRule` commands: an inbound TCP allow for the
 * HFP port and an inbound UDP allow for the discovery port, both scoped to
 * `-Profile Private -RemoteAddress LocalSubnet` (see the module-level "WHY"
 * comment). Every value that isn't a validated integer is quoted; ports are
 * range-checked and interpolated as bare (unquoted) integers only after
 * validation — never interpolated straight from the caller.
 */
export function generateFirewallAllowCommands({
  hfpPort,
  udpPort,
  ruleNamePrefix = DEFAULT_RULE_NAME_PREFIX,
}: FirewallPortOptions): string[] {
  assertValidPort(hfpPort, "hfpPort");
  assertValidPort(udpPort, "udpPort");
  const tcpName = quoteForPowerShellSingle(
    firewallRuleName("hfp-tcp", ruleNamePrefix),
    "ruleNamePrefix",
  );
  const udpName = quoteForPowerShellSingle(
    firewallRuleName("discovery-udp", ruleNamePrefix),
    "ruleNamePrefix",
  );
  return [
    `New-NetFirewallRule -DisplayName ${tcpName} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${hfpPort} -Profile Private -RemoteAddress LocalSubnet`,
    `New-NetFirewallRule -DisplayName ${udpName} -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${udpPort} -Profile Private -RemoteAddress LocalSubnet`,
  ];
}

export interface FirewallRemoveOptions {
  ruleNamePrefix?: string;
}

/**
 * Builds the `Remove-NetFirewallRule` commands for the uninstall path.
 * Derives the same `DisplayName`s as `generateFirewallAllowCommands` via
 * `firewallRuleName`, so add/remove always target the same rules
 * (round-trip is asserted in the test suite).
 */
export function generateFirewallRemoveCommands({
  ruleNamePrefix = DEFAULT_RULE_NAME_PREFIX,
}: FirewallRemoveOptions = {}): string[] {
  const tcpName = quoteForPowerShellSingle(
    firewallRuleName("hfp-tcp", ruleNamePrefix),
    "ruleNamePrefix",
  );
  const udpName = quoteForPowerShellSingle(
    firewallRuleName("discovery-udp", ruleNamePrefix),
    "ruleNamePrefix",
  );
  return [
    `Remove-NetFirewallRule -DisplayName ${tcpName}`,
    `Remove-NetFirewallRule -DisplayName ${udpName}`,
  ];
}

// ---------------------------------------------------------------------------
// Public-profile check.
// ---------------------------------------------------------------------------

/**
 * A `Get-NetConnectionProfile` one-liner that lists every network adapter's
 * profile category. The `setup` CLI runs (or points the user at) this so
 * they can see whether any adapter is on the `Public` profile — the
 * firewall rules above are scoped to `Private` and simply won't apply on a
 * Public-profile adapter, so this check is how a silently-blocked-anyway
 * setup gets surfaced instead of leaving the user to debug connectivity.
 */
export function publicProfileCheckCommand(): string {
  return "Get-NetConnectionProfile | Select-Object -Property Name, InterfaceAlias, NetworkCategory";
}

/**
 * Human-readable explanation shown alongside `publicProfileCheckCommand`'s
 * output. Kept as a constant (not inlined in the CLI) so the wording is
 * covered by this module's own tests, same as the generated commands.
 */
export const PUBLIC_PROFILE_WARNING =
  "WARNING: the firewall rules above only apply on the 'Private' network " +
  "profile. If the command above shows any adapter's NetworkCategory as " +
  "'Public', HomeFleet peers on that network will be blocked even though " +
  "the rules were created successfully. On a trusted home network, switch " +
  "the adapter to Private in Windows Settings > Network & Internet; " +
  "otherwise leave it Public and use a different, trusted network for " +
  "HomeFleet.";

// ---------------------------------------------------------------------------
// Autostart (Task Scheduler, at-logon).
// ---------------------------------------------------------------------------

/** Default Task Scheduler task name for the daemon's autostart entry. */
export const DEFAULT_AUTOSTART_TASK_NAME = "HomeFleet Daemon";

export interface AutostartCreateOptions {
  /** Absolute path to the `node` executable that will run the daemon. */
  nodeExecPath: string;
  /** Absolute path to the daemon's entry script/module. */
  daemonEntryPath: string;
  taskName?: string;
}

/**
 * Builds a `schtasks /Create` command that registers an at-logon
 * (`/SC ONLOGON`) task launching the daemon as the current user.
 * Deliberately omits `/RL HIGHEST` (see the module-level "WHY" comment) —
 * the daemon does not need, and should not run with, elevated rights.
 *
 * `schtasks` follows traditional Windows command-line quoting, not
 * PowerShell's, so the executable + entry path pair is double-quoted the
 * `schtasks`/cmd way and that whole value is then wrapped in a PowerShell
 * single-quoted string for `/TR` — this is the standard pattern for passing
 * a quote-containing literal through PowerShell to a native executable
 * unchanged, and is what lets both paths safely contain spaces.
 */
export function generateAutostartCreateCommand({
  nodeExecPath,
  daemonEntryPath,
  taskName = DEFAULT_AUTOSTART_TASK_NAME,
}: AutostartCreateOptions): string {
  const quotedNode = quoteForDoubleQuoted(nodeExecPath, "nodeExecPath");
  const quotedEntry = quoteForDoubleQuoted(daemonEntryPath, "daemonEntryPath");
  const trValue = quoteForPowerShellSingle(
    `${quotedNode} ${quotedEntry}`,
    "the node/daemon command line",
  );
  const quotedTaskName = quoteForDoubleQuoted(taskName, "taskName");
  return `schtasks /Create /TN ${quotedTaskName} /TR ${trValue} /SC ONLOGON /RL LIMITED /F`;
}

export interface AutostartRemoveOptions {
  taskName?: string;
}

/**
 * Builds the `schtasks /Delete` command for the uninstall path. Takes the
 * same `taskName` default as `generateAutostartCreateCommand` so create and
 * remove target the same task unless the caller overrides both identically.
 */
export function generateAutostartRemoveCommand({
  taskName = DEFAULT_AUTOSTART_TASK_NAME,
}: AutostartRemoveOptions = {}): string {
  const quotedTaskName = quoteForDoubleQuoted(taskName, "taskName");
  return `schtasks /Delete /TN ${quotedTaskName} /F`;
}
