const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { restoreFromCloud, backupToCloud } = require("./backup");
const { startTelegramBot } = require("./bot");

const PORT = parseInt(process.env.PORT || "20128", 10);
const HOST = process.env.HOSTNAME || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(check, 250);
      });
    };
    check();
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log("=== [Runner] Step 1: Checking cloud backup restore ===");
  await restoreFromCloud(DATA_DIR);

  console.log(`=== [Runner] Step 2: Starting 9Router on ${HOST}:${PORT} ===`);
  const customServer = path.resolve("/app/custom-server.js");
  const fallbackServer = path.resolve("/app/server.js");
  const entryScript = fs.existsSync(customServer) ? customServer : fallbackServer;

  let shuttingDown = false;
  let routerProc = null;

  function spawnRouter() {
    routerProc = spawn(
      process.execPath,
      ["--dns-result-order=ipv4first", "--max-old-space-size=360", entryScript],
      {
        cwd: "/app",
        stdio: "inherit",
        env: {
          ...process.env,
          PORT: String(PORT),
          HOSTNAME: HOST,
          DATA_DIR,
        },
      }
    );

    routerProc.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`[Runner] 9Router exited (code=${code}, signal=${signal}). Restarting in 3s...`);
      setTimeout(spawnRouter, 3000);
    });
  }

  spawnRouter();

  const ready = await waitForPort(PORT, 35000);
  if (ready) {
    console.log(`=== [Runner] 9Router is listening on port ${PORT} ===`);
  } else {
    console.warn(`[Runner] 9Router did not respond within 35s, starting Telegram Bot anyway...`);
  }

  console.log("=== [Runner] Step 3: Starting Telegram Bot ===");
  const botHandle = startTelegramBot({ port: PORT, dataDir: DATA_DIR });

  // Periodic background sync to Private GitHub Gist
  const backupTimer = setInterval(() => {
    backupToCloud(DATA_DIR).catch((err) =>
      console.error("[Runner] Scheduled backup error:", err.message)
    );
  }, BACKUP_INTERVAL_MS);

  async function gracefulShutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Runner] Received ${sig}, saving state & shutting down...`);
    clearInterval(backupTimer);
    botHandle.stop();

    try {
      await backupToCloud(DATA_DIR);
    } catch {}

    if (routerProc && routerProc.pid) {
      try { routerProc.kill("SIGTERM"); } catch {}
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[Runner] Fatal startup error:", err);
  process.exit(1);
});
