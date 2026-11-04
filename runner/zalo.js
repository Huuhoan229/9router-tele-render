const fs = require("fs");
const path = require("path");
const { Zalo, ThreadType, LoginQRCallbackEventType } = require("zca-js");
const { backupToCloud } = require("./backup");

const MAX_HISTORY_MESSAGES = 20;

function createZaloManager({ port, dataDir, getApiKey, getDefaultModel, getSystemPrompt }) {
  const routerBase = (process.env.ROUTER_BASE_URL || `http://127.0.0.1:${port}/v1`).replace(/\/+$/, "");
  const credsPath = path.join(dataDir, "zalo-credentials.json");
  const configPath = path.join(dataDir, "telebot-config.json");

  let activeApi = null;
  let ownId = null;
  let accountName = "";
  let loginInProgress = false;
  const histories = new Map(); // threadId -> Array<{ role, content }>

  function readBotConfig() {
    try {
      if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {}
    return {};
  }

  function writeBotConfig(patch) {
    const cur = readBotConfig();
    const next = { ...cur, ...patch };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  function getZaloMode() {
    const cfg = readBotConfig();
    return (cfg.zaloMode || process.env.ZALO_MODE || "dm").toLowerCase();
  }

  function setZaloMode(mode) {
    writeBotConfig({ zaloMode: mode });
    backupToCloud(dataDir).catch(() => {});
  }

  function stopCurrentListener() {
    if (activeApi && activeApi.listener) {
      try {
        activeApi.listener.stop();
      } catch {}
    }
    activeApi = null;
  }

  async function callRouterAI(threadId, userText) {
    const apiKey = getApiKey();
    if (!apiKey) {
      return "⚠️ Chưa có API Key 9Router. Hãy vào Telegram gõ /setkey trước.";
    }

    const model = getDefaultModel() || "a";
    const key = String(threadId);
    const history = histories.get(key) || [];
    history.push({ role: "user", content: userText });
    while (history.length > MAX_HISTORY_MESSAGES) {
      history.shift();
    }
    histories.set(key, history);

    const sysPrompt = getSystemPrompt ? getSystemPrompt() : "";
    const messages = sysPrompt
      ? [{ role: "system", content: sysPrompt }, ...history]
      : [...history];

    try {
      const res = await fetch(`${routerBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
        }),
      });

      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 300)}`);
      }

      const data = JSON.parse(rawText);
      const reply =
        data?.choices?.[0]?.message?.content ||
        data?.content?.[0]?.text ||
        "(AI không trả về nội dung)";

      history.push({ role: "assistant", content: reply });
      while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
      }
      return reply;
    } catch (err) {
      history.pop();
      return `❌ Lỗi gọi 9Router (${model}): ${err.message}`;
    }
  }

  async function handleZaloMessage(api, message) {
    try {
      if (!message || !message.data) return;
      const content = message.data.content;
      if (typeof content !== "string") return;

      let text = content.trim();
      if (!text) return;

      const isGroup = message.type === ThreadType.Group;
      const isCmdAsk = /^\/(ask|ai)(\s+|$)/i.test(text);

      // Ignore own messages unless explicitly testing with /ask or /ai
      if (message.isSelf && !isCmdAsk) return;

      if (/^\/clear$/i.test(text)) {
        histories.delete(String(message.threadId));
        await api.sendMessage({ msg: "🧹 Đã xóa lịch sử hội thoại Zalo!" }, message.threadId, message.type);
        return;
      }

      const mode = getZaloMode();
      if (mode === "off") return;

      const mentions = Array.isArray(message.data.mentions) ? message.data.mentions : [];
      const isMentionedInGroup =
        isGroup && ownId && mentions.some((m) => String(m.uid) === String(ownId));

      if (isCmdAsk) {
        text = text.replace(/^\/(ask|ai)\s*/i, "").trim();
        if (!text) return;
      } else if (mode === "command") {
        // In 'command' mode, only reply if /ask, /ai, or @mentioned in group
        if (!isMentionedInGroup) return;
      } else if (mode === "dm") {
        // In 'dm' mode, reply to all 1-1 messages, and in groups only when @mentioned or /ask
        if (isGroup && !isMentionedInGroup) return;
      }
      // In 'all' mode, reply to everything in both 1-1 and groups

      // Strip @mention text if mentioned in group
      if (isMentionedInGroup && mentions.length > 0) {
        for (const m of [...mentions].sort((a, b) => b.pos - a.pos)) {
          if (String(m.uid) === String(ownId) && typeof m.pos === "number" && typeof m.len === "number") {
            text = (text.slice(0, m.pos) + text.slice(m.pos + m.len)).trim();
          }
        }
        if (!text) return;
      }

      const replyText = await callRouterAI(message.threadId, text);
      if (!replyText) return;

      // Split if message is longer than 3000 chars
      const chunks = [];
      let rem = replyText;
      while (rem.length > 3000) {
        let idx = rem.lastIndexOf("\n", 3000);
        if (idx < 1000) idx = 3000;
        chunks.push(rem.slice(0, idx));
        rem = rem.slice(idx).trimStart();
      }
      if (rem) chunks.push(rem);

      for (let i = 0; i < chunks.length; i++) {
        const msgPayload =
          isGroup && i === 0
            ? { msg: chunks[i], quote: message.data }
            : { msg: chunks[i] };
        await api.sendMessage(msgPayload, message.threadId, message.type);
      }
    } catch (err) {
      console.error("[ZaloBot] Error handling message:", err.message);
    }
  }

  async function bindApiAndListen(api) {
    stopCurrentListener();
    activeApi = api;

    try {
      ownId = api.getOwnId();
    } catch {}

    try {
      const info = await api.fetchAccountInfo();
      accountName = info?.profile?.displayName || info?.displayName || info?.name || "";
    } catch {}

    api.listener.on("message", (msg) => {
      handleZaloMessage(api, msg);
    });

    api.listener.on("connected", () => {
      console.log(`[ZaloBot] Connected! UID=${ownId || "?"} ${accountName ? `(${accountName})` : ""}`);
    });

    api.listener.on("error", (err) => {
      console.error("[ZaloBot] Listener error:", err?.message || err);
    });

    api.listener.on("closed", (code, reason) => {
      console.warn(`[ZaloBot] Listener closed (code=${code}, reason=${reason})`);
    });

    api.listener.start({ retryOnClose: true });
  }

  async function tryAutoLogin() {
    try {
      if (!fs.existsSync(credsPath)) {
        console.log("[ZaloBot] Chưa có zalo-credentials.json (Gõ /zaloqr trên Telegram để quét mã đăng nhập).");
        return false;
      }
      const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
      if (!creds || !creds.cookie || !creds.imei || !creds.userAgent) return false;

      console.log("[ZaloBot] Restoring saved Zalo session...");
      const zalo = new Zalo({ selfListen: true });
      const api = await zalo.login(creds);
      await bindApiAndListen(api);
      return true;
    } catch (err) {
      console.error("[ZaloBot] Auto-login failed (phiên có thể đã hết hạn, hãy gõ /zaloqr lại):", err.message);
      return false;
    }
  }

  async function startQRLoginFlow({ onQRImage, onScanned, onSuccess, onError }) {
    if (loginInProgress) {
      throw new Error("Đang có 1 phiên quét QR Zalo đang chờ. Hãy quét mã QR đã gửi hoặc đợi 1 phút.");
    }
    loginInProgress = true;
    const qrTempFile = path.join(dataDir, "temp-zalo-qr.png");

    try {
      const zalo = new Zalo({ selfListen: true });
      let savedCreds = null;

      const api = await zalo.loginQR(
        { qrPath: qrTempFile },
        async (event) => {
          try {
            if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
              const rawBase64 = (event.data?.image || "").replace(/^data:image\/\w+;base64,/, "");
              if (rawBase64 && onQRImage) {
                await onQRImage(Buffer.from(rawBase64, "base64"));
              }
            } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
              if (onScanned) {
                await onScanned(event.data?.display_name || "Zalo User");
              }
            } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
              savedCreds = {
                cookie: event.data.cookie,
                imei: event.data.imei,
                userAgent: event.data.userAgent,
              };
              fs.mkdirSync(path.dirname(credsPath), { recursive: true });
              fs.writeFileSync(credsPath, JSON.stringify(savedCreds, null, 2), "utf8");
              backupToCloud(dataDir, { force: true }).catch(() => {});
            }
          } catch (cbErr) {
            console.error("[ZaloBot] QR callback error:", cbErr.message);
          }
        }
      );

      await bindApiAndListen(api);
      if (onSuccess) {
        await onSuccess({ ownId, accountName });
      }
    } catch (err) {
      if (onError) await onError(err);
    } finally {
      loginInProgress = false;
      try {
        if (fs.existsSync(qrTempFile)) fs.unlinkSync(qrTempFile);
      } catch {}
    }
  }

  function getStatus() {
    return {
      connected: Boolean(activeApi),
      ownId,
      accountName,
      mode: getZaloMode(),
    };
  }

  return {
    tryAutoLogin,
    startQRLoginFlow,
    getStatus,
    getZaloMode,
    setZaloMode,
    stop: stopCurrentListener,
  };
}

module.exports = { createZaloManager };
