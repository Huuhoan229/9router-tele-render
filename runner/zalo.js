const fs = require("fs");
const path = require("path");
const { Zalo, ThreadType, LoginQRCallbackEventType } = require("zca-js");
const { backupToCloud } = require("./backup");
const {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_IMAGE_PROMPT,
  downloadImageAsDataUrl,
  buildVisionContent,
  cleanForChat,
} = require("./format");

const { createMemoryStore } = require("./memory");

function createZaloManager({ port, dataDir, memoryStore: sharedMemory, getApiKey, getDefaultModel, getSystemPrompt }) {
  const routerBase = (process.env.ROUTER_BASE_URL || `http://127.0.0.1:${port}/v1`).replace(/\/+$/, "");
  const credsPath = path.join(dataDir, "zalo-credentials.json");
  const configPath = path.join(dataDir, "telebot-config.json");
  const memoryStore = sharedMemory || createMemoryStore(dataDir);

  let activeApi = null;
  let ownId = null;
  let accountName = "";
  let loginInProgress = false;
  const pendingImages = new Map(); // threadId -> { url, ts, timer }

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

  function extractZaloDirectImage(data) {
    if (!data) return { imageUrl: null, caption: "" };
    const c = data.content;
    if (!c || typeof c !== "object") return { imageUrl: null, caption: "" };

    let hdFromParams = "";
    if (typeof c.params === "string" && c.params.startsWith("{")) {
      try {
        const parsed = JSON.parse(c.params);
        hdFromParams = parsed.hd || parsed.hdUrl || parsed.rawUrl || "";
      } catch {}
    }

    const urlCandidate = hdFromParams || c.href || c.hdUrl || c.normalUrl || c.thumb || "";
    const isPhoto =
      data.msgType === "chat.photo" ||
      (typeof urlCandidate === "string" &&
        /^https?:\/\//i.test(urlCandidate) &&
        (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(urlCandidate) || urlCandidate.includes("zdn.vn")));

    if (!isPhoto || !urlCandidate) return { imageUrl: null, caption: "" };
    const caption = String(c.title || c.description || "").trim();
    return { imageUrl: urlCandidate, caption };
  }

  function extractZaloQuotedImage(data) {
    const attach = data?.quote?.attach;
    if (!attach) return null;
    try {
      const obj = typeof attach === "string" ? JSON.parse(attach) : attach;
      let hdFromParams = "";
      if (typeof obj?.params === "string" && obj.params.startsWith("{")) {
        try {
          const p = JSON.parse(obj.params);
          hdFromParams = p.hd || p.hdUrl || "";
        } catch {}
      }
      const url = hdFromParams || obj?.href || obj?.hdUrl || obj?.normalUrl || obj?.thumbUrl || obj?.thumb || "";
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        return url;
      }
    } catch {}
    return null;
  }

  async function callRouterAI(threadId, userText, imageUrls = []) {
    const apiKey = getApiKey();
    if (!apiKey) {
      return "⚠️ Chưa có API Key 9Router. Hãy vào Telegram gõ /setkey trước.";
    }

    const model = getDefaultModel() || "a";
    const memKey = `zalo:${threadId}`;

    try {
      const priorHistory = memoryStore.getHistoryForRequest(memKey);
      let userContent = userText || DEFAULT_IMAGE_PROMPT;
      if (imageUrls.length > 0) {
        const dataUrls = [];
        for (const u of imageUrls) {
          dataUrls.push(await downloadImageAsDataUrl(u));
        }
        userContent = buildVisionContent(userText, dataUrls);
      }

      const sysPrompt = (getSystemPrompt ? getSystemPrompt() : "") || DEFAULT_CHAT_SYSTEM_PROMPT;
      const messages = [
        { role: "system", content: sysPrompt },
        ...priorHistory,
        { role: "user", content: userContent },
      ];

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
      const rawReply =
        data?.choices?.[0]?.message?.content ||
        data?.content?.[0]?.text ||
        "(AI không trả về nội dung)";
      const reply = cleanForChat(rawReply);

      const savedUserText =
        imageUrls.length > 0
          ? `[Người dùng gửi ảnh] ${userText || DEFAULT_IMAGE_PROMPT}`
          : userText || DEFAULT_IMAGE_PROMPT;
      memoryStore.appendCompletedTurn(memKey, savedUserText, reply);

      return reply;
    } catch (err) {
      const visionHint =
        imageUrls.length > 0
          ? "\n(Lưu ý: Hãy chọn Model/Combo có hỗ trợ Vision hoặc bật Vision Adapter trên 9Router)"
          : "";
      return `❌ Lỗi gọi 9Router (${model}): ${err.message}${visionHint}`;
    }
  }

  async function sendZaloChunks(api, message, replyText) {
    if (!replyText) return;
    const isGroup = message.type === ThreadType.Group;
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
  }

  async function handleZaloMessage(api, message) {
    try {
      if (!message || !message.data) return;
      const content = message.data.content;
      const threadKey = String(message.threadId);
      const isGroup = message.type === ThreadType.Group;

      const { imageUrl: directImageUrl, caption } = extractZaloDirectImage(message.data);
      const quotedImageUrl = extractZaloQuotedImage(message.data);

      let text = "";
      if (typeof content === "string") {
        text = content.trim();
      } else if (directImageUrl) {
        text = caption;
      } else {
        return;
      }

      if (!text && !directImageUrl) return;

      const isCmdAsk = /^\/(ask|ai)(\s+|$)/i.test(text);

      // Ignore own messages unless explicitly testing with /ask or /ai (or saving own image for /ask)
      if (message.isSelf && !isCmdAsk) {
        if (directImageUrl) {
          pendingImages.set(threadKey, { url: directImageUrl, ts: Date.now(), timer: null });
        }
        return;
      }

      if (/^\/clear$/i.test(text)) {
        memoryStore.clearThread(`zalo:${threadKey}`);
        pendingImages.delete(threadKey);
        await api.sendMessage({ msg: "🧹 Đã xóa lịch sử hội thoại Zalo!" }, message.threadId, message.type);
        return;
      }

      const mode = getZaloMode();
      if (mode === "off") return;

      const mentions = Array.isArray(message.data.mentions) ? message.data.mentions : [];
      const isMentionedInGroup =
        isGroup && ownId && mentions.some((m) => String(m.uid) === String(ownId));

      let shouldAnswer = false;
      if (isCmdAsk) {
        text = text.replace(/^\/(ask|ai)\s*/i, "").trim();
        shouldAnswer = true;
      } else if (mode === "command") {
        shouldAnswer = isMentionedInGroup;
      } else if (mode === "dm") {
        shouldAnswer = !isGroup || isMentionedInGroup;
      } else if (mode === "all") {
        shouldAnswer = true;
      }

      if (!shouldAnswer) {
        // Store unanswered image for 2 minutes in case user sends /ask or @mention right after
        if (directImageUrl) {
          const prev = pendingImages.get(threadKey);
          if (prev?.timer) clearTimeout(prev.timer);
          pendingImages.set(threadKey, { url: directImageUrl, ts: Date.now(), timer: null });
        }
        return;
      }

      // Strip @mention text if mentioned in group
      if (isMentionedInGroup && mentions.length > 0 && text) {
        for (const m of [...mentions].sort((a, b) => b.pos - a.pos)) {
          if (String(m.uid) === String(ownId) && typeof m.pos === "number" && typeof m.len === "number") {
            text = (text.slice(0, m.pos) + text.slice(m.pos + m.len)).trim();
          }
        }
      }

      // If user sent an image WITHOUT text in dm/all mode, wait 1.5s in case Zalo sends follow-up caption text as a 2nd message!
      if (directImageUrl && !text) {
        const prev = pendingImages.get(threadKey);
        if (prev?.timer) clearTimeout(prev.timer);

        const timer = setTimeout(async () => {
          pendingImages.delete(threadKey);
          try {
            const replyText = await callRouterAI(message.threadId, "", [directImageUrl]);
            await sendZaloChunks(api, message, replyText);
          } catch (e) {
            console.error("[ZaloBot] Delayed image reply error:", e.message);
          }
        }, 1500);

        pendingImages.set(threadKey, { url: directImageUrl, ts: Date.now(), timer });
        return;
      }

      // Determine final image(s) to attach (direct -> quoted -> pending within 2 mins)
      let targetImageUrl = directImageUrl || quotedImageUrl || null;
      if (!targetImageUrl) {
        const pending = pendingImages.get(threadKey);
        if (pending && Date.now() - pending.ts < 2 * 60 * 1000) {
          if (pending.timer) clearTimeout(pending.timer);
          targetImageUrl = pending.url;
          pendingImages.delete(threadKey);
        }
      } else {
        const prev = pendingImages.get(threadKey);
        if (prev?.timer) clearTimeout(prev.timer);
        pendingImages.delete(threadKey);
      }

      if (!text && !targetImageUrl) return;

      const quotedMsgText = String(message.data?.quote?.msg || "").trim();
      const senderLabel = isGroup && message.data?.dName ? `[${message.data.dName}]: ` : "";
      let contextualText = text || "";
      if (quotedMsgText) {
        contextualText = `[Đang trả lời tin nhắn: "${quotedMsgText.slice(0, 600)}"]\n${contextualText}`;
      }
      if (senderLabel && contextualText) {
        contextualText = `${senderLabel}${contextualText}`;
      }

      const replyText = await callRouterAI(
        message.threadId,
        contextualText,
        targetImageUrl ? [targetImageUrl] : []
      );
      await sendZaloChunks(api, message, replyText);
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
