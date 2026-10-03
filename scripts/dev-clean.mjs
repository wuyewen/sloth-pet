// dev 启动前清理残留进程：vite 占着 1420 端口 / 上次的 app 本体没退干净，
// 会导致 tauri dev 直接启动失败（Port 1420 is already in use）
import { execSync } from "node:child_process";

const opts = { stdio: "ignore", shell: true };

try {
  if (process.platform === "win32") {
    const out = execSync("netstat -ano").toString();
    const pids = new Set(
      out
        .split("\n")
        .filter((l) => l.includes(":1420") && l.includes("LISTENING"))
        .map((l) => l.trim().split(/\s+/).pop())
        .filter(Boolean)
    );
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, opts);
      } catch {}
    }
    try {
      execSync("taskkill /F /IM sloth-pet.exe", opts);
    } catch {}
  } else {
    execSync("lsof -ti:1420 | xargs kill -9", opts);
    execSync("pkill -f 'target/debug/sloth-pet'", opts);
  }
} catch {
  // 没有残留进程时命令非零退出，属正常
}
