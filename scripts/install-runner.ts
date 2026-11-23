import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// Installs the runner as a background service that starts on its own and restarts when it exits.
//   macOS: a launchd LaunchAgent, logging to ~/Library/Logs/marshal-factory/runner.log
//   Linux: a systemd user service with lingering on, so it runs from boot without a login,
//          logging to ~/.local/state/marshal-factory/runner.log
// Re-running with nothing changed leaves it alone.
//   bun scripts/install-runner.ts [--uninstall]

export const LABEL = "com.marshal-factory.runner";
export const UNIT = "marshal-factory-runner.service";
const root = join(import.meta.dirname, "..");
const uninstall = process.argv.includes("--uninstall");

const which = (bin: string) => {
  try {
    return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

/** The runner's tools. A service starts with a bare PATH, so carry every directory they live in. */
function toolchain() {
  const bun = process.execPath.endsWith("/bun") ? process.execPath : which("bun");
  if (!bun) throw new Error("bun is not on PATH");
  const found = ["git", "gh", "claude", "codex", "jq"].map(which).filter(Boolean);
  // T3 exports its CLI path only to sessions it starts; the daemon gets it from here.
  const t3 = process.env.T3CODE_CLI_PATH ?? [join(homedir(), ".t3/bin/t3")].find(existsSync) ?? which("t3");
  const path = [...new Set([...[bun, ...found, ...(t3 ? [t3] : [])].map(dirname), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  return { bun, t3, path };
}

/** The systemd unit, exported for the regressions. Values are quoted for systemd's parser. */
export function systemdUnit({ bun, root: dir, path, home, t3, t3Home, logPath }: { bun: string; root: string; path: string; home: string; t3: string; t3Home?: string; logPath: string }) {
  const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=marshal-factory runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${dir}
ExecStart=${quote(bun)} ${quote(join(dir, "runner/index.ts"))}
Environment=${quote(`PATH=${path}`)}
Environment=${quote(`HOME=${home}`)}
${t3 ? `Environment=${quote(`T3CODE_CLI_PATH=${t3}`)}\n` : ""}${t3Home ? `Environment=${quote(`T3CODE_HOME=${t3Home}`)}\n` : ""}Restart=always
RestartSec=10
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

function installLinux() {
  const unitPath = join(homedir(), ".config/systemd/user", UNIT);
  const logPath = join(homedir(), ".local/state/marshal-factory/runner.log");
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}` };
  const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: "pipe", env });
  const active = () => {
    try {
      return systemctl("is-active", UNIT).trim() === "active";
    } catch {
      return false;
    }
  };

  if (uninstall) {
    try {
      systemctl("disable", "--now", UNIT);
    } catch {
      // Not installed; nothing to stop.
    }
    console.log(`stopped   ${UNIT}; ${unitPath} left in place`);
    return;
  }

  const { bun, t3, path } = toolchain();
  // T3CODE_HOME picks which T3 server the runner's threads go to, such as a headless one beside the desktop app's.
  const unit = systemdUnit({ bun, root, path, home: homedir(), t3, t3Home: process.env.T3CODE_HOME, logPath });
  mkdirSync(dirname(unitPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const changed = !existsSync(unitPath) || readFileSync(unitPath, "utf8") !== unit;
  if (changed) {
    writeFileSync(unitPath, unit);
    systemctl("daemon-reload");
  }
  // Lingering keeps the user's services running without a login session, and starts them at boot.
  try {
    const linger = execFileSync("loginctl", ["show-user", userInfo().username, "--property=Linger"], { encoding: "utf8" }).trim();
    if (linger !== "Linger=yes") execFileSync("loginctl", ["enable-linger", userInfo().username], { stdio: "inherit" });
  } catch (error) {
    console.warn(`could not turn on lingering (${error instanceof Error ? error.message : String(error)}); run: sudo loginctl enable-linger ${userInfo().username}`);
  }
  const wasActive = active();
  systemctl("enable", UNIT);
  if (changed && wasActive) systemctl("restart", UNIT);
  else if (!wasActive) systemctl("start", UNIT);
  console.log(`${changed ? "installed" : wasActive ? "unchanged" : "started"} ${UNIT}; log ${logPath}`);
}

function installMac() {
  const plistPath = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  const logPath = join(homedir(), "Library/Logs/marshal-factory/runner.log");
  const domain = `gui/${userInfo().uid}`;
  const launchctl = (...args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: "pipe" });
  const loaded = () => {
    try {
      launchctl("print", `${domain}/${LABEL}`);
      return true;
    } catch {
      return false;
    }
  };

  if (uninstall) {
    if (loaded()) launchctl("bootout", `${domain}/${LABEL}`);
    console.log(`unloaded  ${LABEL}; ${plistPath} left in place`);
    return;
  }

  // launchd starts with a bare PATH, so carry the directories of every tool the runner calls.
  const tools = ["bun", "git"].map(which);
  // T3 installs its launcher at ~/.t3/bin/t3 and puts it on the login shell's PATH; launchd has neither.
  const t3 = process.env.T3CODE_CLI_PATH ?? [join(homedir(), ".t3/bin/t3")].find(existsSync) ?? which("t3");
  const path = [...new Set([...tools.map(dirname), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escape(tools[0]!)}</string><string>${escape(join(root, "runner/index.ts"))}</string></array>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(path)}</string>
    <key>HOME</key><string>${escape(homedir())}</string>
    <key>T3CODE_CLI_PATH</key><string>${escape(t3)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(logPath)}</string>
</dict>
</plist>
`;

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const changed = !existsSync(plistPath) || readFileSync(plistPath, "utf8") !== plist;
  if (changed) writeFileSync(plistPath, plist);
  if (changed && loaded()) {
    launchctl("bootout", `${domain}/${LABEL}`);
    // bootout returns before the old process is gone; bootstrap fails until it is.
    for (let i = 0; i < 50 && loaded(); i++) execFileSync("/bin/sleep", ["0.2"]);
  }
  const wasLoaded = loaded();
  if (changed || !wasLoaded) launchctl("bootstrap", domain, plistPath);
  console.log(`${changed ? "installed" : wasLoaded ? "unchanged" : "loaded"} ${LABEL}; log ${logPath}`);
}

if (process.argv[1]?.endsWith("install-runner.ts")) {
  if (process.platform === "darwin") installMac();
  else if (process.platform === "linux") installLinux();
  else throw new Error(`install-runner supports macOS and Linux, not ${process.platform}`);
}
