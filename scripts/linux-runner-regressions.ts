import "./test-guard";
import assert from "node:assert/strict";

const { identify, parseMachineId, parseMeminfo, parseDf } = await import("../runner/heartbeat");
const { systemdUnit, UNIT } = await import("./install-runner");

// ---- Machine identity on Linux: /etc/machine-id, then the D-Bus copy, then the host name.
{
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(parseMachineId(`${id}\n`), id, "a machine id is read with its newline trimmed");
  assert.equal(parseMachineId("uninitialized\n"), undefined, "a machine id not yet set is no id");
  assert.equal(parseMachineId("0".repeat(32)), undefined, "an all-zero id is no id");
  assert.equal(parseMachineId("ABCDEF"), undefined);

  const files = (contents: Record<string, string>) => async (path: string) => {
    if (path in contents) return contents[path]!;
    throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
  };
  const noExec = async () => {
    throw new Error("Linux runs no macOS tools");
  };
  const linux = { platform: "linux" as const, exec: noExec, host: () => "union-server" };

  assert.deepEqual(await identify(undefined, { ...linux, read: files({ "/etc/machine-id": `${id}\n` }) }), { id: `machine-id:${id}`, name: "union-server", idFrom: "machine-id" }, "Linux uses /etc/machine-id");
  assert.deepEqual(
    await identify(undefined, { ...linux, read: files({ "/etc/machine-id": "", "/var/lib/dbus/machine-id": id }) }),
    { id: `machine-id:${id}`, name: "union-server", idFrom: "machine-id" },
    "an empty /etc/machine-id falls back to the D-Bus copy",
  );
  assert.deepEqual(await identify(undefined, { ...linux, read: files({}) }), { id: "hostname:union-server", name: "union-server", idFrom: "hostname" }, "with neither, the host name");
  assert.deepEqual(await identify("pinned", { ...linux, read: files({ "/etc/machine-id": id }) }), { id: "pinned", name: "union-server", idFrom: "config" }, "factory.machineId still wins");

  const mac = await identify(undefined, {
    platform: "darwin",
    read: files({}),
    host: () => "mac.local",
    exec: async (cmd) => (cmd === "scutil" ? "Studio\n" : '  "IOPlatformUUID" = "ABC-123"\n'),
  });
  assert.deepEqual(mac, { id: "ABC-123", name: "Studio", idFrom: "ioreg" }, "macOS keeps the hardware UUID");
}

// ---- Linux memory and disk.
{
  const meminfo = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nSwapTotal: 0 kB\n";
  assert.deepEqual(parseMeminfo(meminfo), { usedBytes: 10_000_000 * 1024, totalBytes: 16_000_000 * 1024 }, "in use is total minus what the kernel can hand back");
  assert.throws(() => parseMeminfo("MemTotal: 1 kB\n"), /MemAvailable/);
  const df = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda3      745000000 199000000 508000000      29% /\n";
  assert.deepEqual(parseDf(df), { freeBytes: 508_000_000 * 1024, totalBytes: 745_000_000 * 1024 }, "POSIX df output (df -Pk) parses");
}

// ---- The systemd user unit.
{
  const unit = systemdUnit({ bun: "/home/u/.bun/bin/bun", root: "/home/u/code/marshal-factory", path: "/home/u/.bun/bin:/usr/bin", home: "/home/u", t3: "/home/u/.t3/bin/t3", logPath: "/home/u/.local/state/marshal-factory/runner.log" });
  assert.equal(UNIT, "marshal-factory-runner.service");
  assert.match(unit, /^ExecStart="\/home\/u\/\.bun\/bin\/bun" "\/home\/u\/code\/marshal-factory\/runner\/index\.ts"$/m, "it runs the live checkout's runner with bun");
  assert.match(unit, /^WorkingDirectory=\/home\/u\/code\/marshal-factory$/m);
  assert.match(unit, /^Restart=always$/m, "it restarts whenever it exits");
  assert.match(unit, /^RestartSec=10$/m);
  assert.match(unit, /^Environment="PATH=\/home\/u\/\.bun\/bin:\/usr\/bin"$/m, "it carries the tools' PATH");
  assert.match(unit, /^Environment="T3CODE_CLI_PATH=\/home\/u\/\.t3\/bin\/t3"$/m, "and the t3 CLI");
  assert.match(unit, /^StandardOutput=append:\/home\/u\/\.local\/state\/marshal-factory\/runner\.log$/m, "it logs to a file");
  assert.match(unit, /^WantedBy=default\.target$/m, "it starts with the user's service manager, which lingering starts at boot");
  const quoted = systemdUnit({ bun: '/opt/my "bun"', root: "/r", path: "/p", home: "/h", t3: "", logPath: "/l" });
  assert.match(quoted, /^ExecStart="\/opt\/my \\"bun\\"" /m, "quotes in paths are escaped");
  assert.doesNotMatch(quoted, /T3CODE_CLI_PATH/, "no t3 found: no T3 variable");
  assert.doesNotMatch(unit, /T3CODE_HOME/, "no T3CODE_HOME at install: T3 picks its default");
  assert.match(systemdUnit({ bun: "/b", root: "/r", path: "/p", home: "/h", t3: "/t3", t3Home: "/h/.t3-factory", logPath: "/l" }), /^Environment="T3CODE_HOME=\/h\/\.t3-factory"$/m, "T3CODE_HOME at install goes to the service");
}

console.log("linux runner regressions passed");
process.exit(0);
