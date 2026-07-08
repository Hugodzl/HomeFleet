import { describe, expect, test } from "vitest";
import {
  DEFAULT_AUTOSTART_TASK_NAME,
  DEFAULT_RULE_NAME_PREFIX,
  firewallRuleName,
  generateAutostartCreateCommand,
  generateAutostartRemoveCommand,
  generateFirewallAllowCommands,
  generateFirewallRemoveCommands,
  PUBLIC_PROFILE_WARNING,
  publicProfileCheckCommand,
} from "./setup-commands.js";

describe("firewallRuleName", () => {
  test("builds the default DisplayNames", () => {
    expect(firewallRuleName("hfp-tcp")).toBe("HomeFleet HFP (TCP)");
    expect(firewallRuleName("discovery-udp")).toBe("HomeFleet Discovery (UDP)");
  });

  test("honors a custom prefix", () => {
    expect(firewallRuleName("hfp-tcp", "MyHost")).toBe("MyHost HFP (TCP)");
  });

  test("uses DEFAULT_RULE_NAME_PREFIX as the implicit default", () => {
    expect(firewallRuleName("hfp-tcp", DEFAULT_RULE_NAME_PREFIX)).toBe(
      firewallRuleName("hfp-tcp"),
    );
  });
});

describe("generateFirewallAllowCommands", () => {
  test("exact commands for the default HFP/discovery ports", () => {
    const commands = generateFirewallAllowCommands({
      hfpPort: 56370,
      udpPort: 56371,
    });
    expect(commands).toEqual([
      "New-NetFirewallRule -DisplayName 'HomeFleet HFP (TCP)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 56370 -Profile Private -RemoteAddress LocalSubnet",
      "New-NetFirewallRule -DisplayName 'HomeFleet Discovery (UDP)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 56371 -Profile Private -RemoteAddress LocalSubnet",
    ]);
  });

  test("exact commands for a custom port pair and rule prefix", () => {
    const commands = generateFirewallAllowCommands({
      hfpPort: 12345,
      udpPort: 12346,
      ruleNamePrefix: "TestHost",
    });
    expect(commands).toEqual([
      "New-NetFirewallRule -DisplayName 'TestHost HFP (TCP)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 12345 -Profile Private -RemoteAddress LocalSubnet",
      "New-NetFirewallRule -DisplayName 'TestHost Discovery (UDP)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 12346 -Profile Private -RemoteAddress LocalSubnet",
    ]);
  });

  test.each([
    0,
    65536,
    -1,
    1.5,
    Number.NaN,
  ])("throws for an out-of-range or non-integer hfpPort (%s)", (badPort) => {
    expect(() =>
      generateFirewallAllowCommands({ hfpPort: badPort, udpPort: 56371 }),
    ).toThrow();
  });

  test.each([
    0,
    65536,
    -1,
    1.5,
    Number.NaN,
  ])("throws for an out-of-range or non-integer udpPort (%s)", (badPort) => {
    expect(() =>
      generateFirewallAllowCommands({ hfpPort: 56370, udpPort: badPort }),
    ).toThrow();
  });

  test("accepts the boundary ports 1 and 65535", () => {
    expect(() =>
      generateFirewallAllowCommands({ hfpPort: 1, udpPort: 65535 }),
    ).not.toThrow();
  });
});

describe("generateFirewallRemoveCommands", () => {
  test("exact commands for the default prefix", () => {
    expect(generateFirewallRemoveCommands()).toEqual([
      "Remove-NetFirewallRule -DisplayName 'HomeFleet HFP (TCP)'",
      "Remove-NetFirewallRule -DisplayName 'HomeFleet Discovery (UDP)'",
    ]);
  });

  test("round-trips: remove targets the same DisplayNames add created", () => {
    const ruleNamePrefix = "CustomPrefix";
    const [addTcp, addUdp] = generateFirewallAllowCommands({
      hfpPort: 56370,
      udpPort: 56371,
      ruleNamePrefix,
    });
    const [removeTcp, removeUdp] = generateFirewallRemoveCommands({
      ruleNamePrefix,
    });
    expect(addTcp).toContain(
      `-DisplayName '${firewallRuleName("hfp-tcp", ruleNamePrefix)}'`,
    );
    expect(removeTcp).toBe(
      `Remove-NetFirewallRule -DisplayName '${firewallRuleName("hfp-tcp", ruleNamePrefix)}'`,
    );
    expect(addUdp).toContain(
      `-DisplayName '${firewallRuleName("discovery-udp", ruleNamePrefix)}'`,
    );
    expect(removeUdp).toBe(
      `Remove-NetFirewallRule -DisplayName '${firewallRuleName("discovery-udp", ruleNamePrefix)}'`,
    );
  });
});

describe("publicProfileCheckCommand / PUBLIC_PROFILE_WARNING", () => {
  test("looks like a Get-NetConnectionProfile invocation", () => {
    const command = publicProfileCheckCommand();
    expect(command).toMatch(/^Get-NetConnectionProfile\b/);
    expect(command).toContain("NetworkCategory");
  });

  test("warning constant mentions Public", () => {
    expect(PUBLIC_PROFILE_WARNING).toMatch(/Public/);
    expect(PUBLIC_PROFILE_WARNING.length).toBeGreaterThan(20);
  });
});

describe("generateAutostartCreateCommand", () => {
  test("exact command with default task name, no spaces in paths", () => {
    const command = generateAutostartCreateCommand({
      nodeExecPath: "C:\\Node\\node.exe",
      daemonEntryPath: "C:\\HomeFleet\\daemon.js",
    });
    expect(command).toBe(
      'schtasks /Create /TN "HomeFleet Daemon" /TR \'"C:\\Node\\node.exe" "C:\\HomeFleet\\daemon.js"\' /SC ONLOGON /RL LIMITED /F',
    );
  });

  test("quotes paths containing spaces correctly", () => {
    const command = generateAutostartCreateCommand({
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      daemonEntryPath: "C:\\Program Files\\HomeFleet\\daemon entry.js",
    });
    expect(command).toBe(
      'schtasks /Create /TN "HomeFleet Daemon" /TR \'"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\HomeFleet\\daemon entry.js"\' /SC ONLOGON /RL LIMITED /F',
    );
  });

  test("does not use the highest run level", () => {
    const command = generateAutostartCreateCommand({
      nodeExecPath: "C:\\Node\\node.exe",
      daemonEntryPath: "C:\\HomeFleet\\daemon.js",
    });
    expect(command).not.toMatch(/highest/i);
    expect(command).toContain("/RL LIMITED");
  });

  test("registers an onlogon trigger", () => {
    const command = generateAutostartCreateCommand({
      nodeExecPath: "C:\\Node\\node.exe",
      daemonEntryPath: "C:\\HomeFleet\\daemon.js",
    });
    expect(command).toContain("/SC ONLOGON");
  });

  test("honors a custom task name", () => {
    const command = generateAutostartCreateCommand({
      nodeExecPath: "C:\\Node\\node.exe",
      daemonEntryPath: "C:\\HomeFleet\\daemon.js",
      taskName: "My Custom Task",
    });
    expect(command).toContain('/TN "My Custom Task"');
  });

  test.each([
    'C:\\bad"path\\node.exe',
    "C:\\bad\npath\\node.exe",
    "",
  ])("throws for an unsafe or empty nodeExecPath (%j)", (badPath) => {
    expect(() =>
      generateAutostartCreateCommand({
        nodeExecPath: badPath,
        daemonEntryPath: "C:\\HomeFleet\\daemon.js",
      }),
    ).toThrow();
  });

  test.each([
    'C:\\bad"path\\daemon.js',
    "C:\\bad\npath\\daemon.js",
    "",
  ])("throws for an unsafe or empty daemonEntryPath (%j)", (badPath) => {
    expect(() =>
      generateAutostartCreateCommand({
        nodeExecPath: "C:\\Node\\node.exe",
        daemonEntryPath: badPath,
      }),
    ).toThrow();
  });
});

describe("generateAutostartRemoveCommand", () => {
  test("exact command with the default task name", () => {
    expect(generateAutostartRemoveCommand()).toBe(
      'schtasks /Delete /TN "HomeFleet Daemon" /F',
    );
  });

  test("round-trips: remove targets the same task name create used", () => {
    const taskName = "My Custom Task";
    const createCommand = generateAutostartCreateCommand({
      nodeExecPath: "C:\\Node\\node.exe",
      daemonEntryPath: "C:\\HomeFleet\\daemon.js",
      taskName,
    });
    const removeCommand = generateAutostartRemoveCommand({ taskName });
    expect(createCommand).toContain(`/TN "${taskName}"`);
    expect(removeCommand).toBe(`schtasks /Delete /TN "${taskName}" /F`);
  });

  test("default task name matches DEFAULT_AUTOSTART_TASK_NAME", () => {
    expect(generateAutostartRemoveCommand()).toContain(
      `"${DEFAULT_AUTOSTART_TASK_NAME}"`,
    );
  });
});

describe("safe quoting of prefixes / names", () => {
  test("a rule prefix with a space and single quote is escaped, not broken", () => {
    const commands = generateFirewallAllowCommands({
      hfpPort: 56370,
      udpPort: 56371,
      ruleNamePrefix: "Bob's House",
    });
    // PowerShell single-quote escaping doubles the embedded `'`.
    expect(commands[0]).toContain("-DisplayName 'Bob''s House HFP (TCP)'");
    expect(commands[1]).toContain(
      "-DisplayName 'Bob''s House Discovery (UDP)'",
    );
  });

  test("a task name with a space and single quote is preserved literally", () => {
    const command = generateAutostartRemoveCommand({
      taskName: "Bob's Task",
    });
    expect(command).toBe('schtasks /Delete /TN "Bob\'s Task" /F');
  });

  test("a control character in a rule prefix is rejected", () => {
    expect(() =>
      generateFirewallAllowCommands({
        hfpPort: 56370,
        udpPort: 56371,
        ruleNamePrefix: "Bad\nPrefix",
      }),
    ).toThrow();
  });

  test("a control character in a task name is rejected", () => {
    expect(() =>
      generateAutostartRemoveCommand({ taskName: "Bad\tName" }),
    ).toThrow();
  });

  test("a double quote in a task name is rejected", () => {
    expect(() =>
      generateAutostartRemoveCommand({ taskName: 'Bad"Name' }),
    ).toThrow();
  });
});
