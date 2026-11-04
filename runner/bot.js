const fs = require("fs");
const path = require("path");
const { backupToCloud } = require("./backup");
const { createZaloManager } = require("./zalo");

const MAX_HISTORY_MESSAGES = 20;
const MAX_TELEGRAM_LENGTH = 4000;

function loadBotConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch (err) {
    console.error("[TeleBot] Failed to read telebot-config.json:", err.message);
  }
  return {};
}

function saveBotConfig(configPath, cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch (err) {
    console.error("[TeleBot] Failed to save telebot-config.json:", err.message);
  }
}

function splitLongText(text, maxLen = MAX_TELEGRAM_LENGTH) {
  if (!text || text.length <= maxLen) return [text || "(Trống)"];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.4) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function startTelegramBot({ port, dataDir, zaloManager }) {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!botToken) {
    console.warn("[TeleBot] TELEGRAM_BOT_TOKEN chưa được cài đặt — chỉ chạy 9Router Web/API.");
    return { stop: () => {} };
  }

  const tgBase = `https://api.telegram.org/bot${botToken}`;
  const routerBase = (process.env.ROUTER_BASE_URL || `http://127.0.0.1:${port}/v1`).replace(/\/+$/, "");
  const configPath = path.join(dataDir, "telebot-config.json");

  let persisted = loadBotConfig(configPath);
  const histories = new Map(); // chatId -> Array<{ role, content }>
  let running = true;
  let pollAbort = null;
  let botUsername = "";
  let botId = null;

  const allowedIds = (process.env.ALLOWED_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  function getApiKey() {
    const manual = (persisted.routerApiKey || process.env.ROUTER_API_KEY || "").trim();
    if (manual) return manual;

    // Auto-read active API Key directly from 9Router SQLite database if available
    try {
      const dbPath = path.join(dataDir, "db", "data.sqlite");
      if (fs.existsSync(dbPath)) {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        const row = db.prepare("SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1").get();
        db.close();
        if (row && row.key) return String(row.key).trim();
      }
    } catch {}
    return "";
  }

  function getActiveModel(chatId) {
    const chatModels = persisted.chatModels || {};
    return (
      chatModels[String(chatId)] ||
      persisted.defaultModel ||
      process.env.DEFAULT_MODEL ||
      ""
    ).trim();
  }

  function getSystemPrompt(chatId) {
    const prompts = persisted.systemPrompts || {};
    return (prompts[String(chatId)] || process.env.SYSTEM_PROMPT || "").trim();
  }

  if (!zaloManager) {
    try {
      zaloManager = createZaloManager({
        port,
        dataDir,
        getApiKey,
        getDefaultModel: () => getActiveModel("default") || "a",
        getSystemPrompt: () => getSystemPrompt("default"),
      });
      zaloManager.tryAutoLogin().catch((err) =>
        console.error("[ZaloBot] Auto-login check error:", err.message)
      );
    } catch (err) {
      console.error("[ZaloBot] Failed to init ZaloManager:", err.message);
    }
  }

  async function tgCall(method, body = {}, signal) {
    const res = await fetch(`${tgBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) {
      throw new Error(`Telegram ${method} error: ${data.description || res.status}`);
    }
    return data.result;
  }

  async function sendPhotoBuffer(chatId, pngBuffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    form.append("photo", new Blob([pngBuffer], { type: "image/png" }), "zalo-qr.png");

    const res = await fetch(`${tgBase}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      throw new Error(`sendPhoto failed: ${data.description || res.status}`);
    }
    return data.result;
  }

  async function sendReply(chatId, text, extra = {}) {
    const parts = splitLongText(String(text || ""));
    for (let i = 0; i < parts.length; i++) {
      const opts = i === parts.length - 1 ? extra : {};
      try {
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: parts[i],
          ...opts,
        });
      } catch (err) {
        console.error("[TeleBot] sendMessage failed:", err.message);
      }
    }
  }

  async function fetchAvailableModels() {
    const comboNames = [];
    try {
      const dbPath = path.join(dataDir, "db", "data.sqlite");
      if (fs.existsSync(dbPath)) {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        const rows = db.prepare("SELECT name FROM combos").all();
        db.close();
        for (const r of rows) {
          if (r && r.name) comboNames.push(String(r.name).trim());
        }
      }
    } catch {}

    const apiKey = getApiKey();
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    try {
      const res = await fetch(`${routerBase}/models`, { headers });
      if (res.ok) {
        const json = await res.json();
        const list = Array.isArray(json?.data) ? json.data : [];
        const apiModels = list.map((m) => m.id).filter(Boolean);
        return [...new Set([...comboNames, ...apiModels])];
      }
    } catch {}

    return comboNames;
  }

  async function ensureModelSelected(chatId) {
    let model = getActiveModel(chatId);
    if (model) return model;

    try {
      const models = await fetchAvailableModels();
      if (models.length > 0) {
        model = models[0];
        persisted.defaultModel = model;
        saveBotConfig(configPath, persisted);
        return model;
      }
    } catch {}
    return "";
  }

  function isAuthorized(userId) {
    if (allowedIds.length === 0) return true;
    return allowedIds.includes(String(userId));
  }

  async function handleCommand(msg, text) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const [rawCmd, ...rest] = text.trim().split(/\s+/);
    const cmd = rawCmd.split("@")[0].toLowerCase();
    const argText = text.trim().slice(rawCmd.length).trim();

    if (cmd === "/start" || cmd === "/help") {
      const hasKey = Boolean(getApiKey());
      const currentModel = getActiveModel(chatId) || "(Chưa chọn — tự động lấy từ 9Router)";
      const lines = [
        "🤖 *9Router Telegram AI Chatbox*",
        "",
        `• *Telegram ID của bạn:* \`${userId}\``,
        `• *Trạng thái API Key 9Router:* ${hasKey ? "✅ Đã kết nối" : "⚠️ Chưa gắn key (dùng /setkey)"}`,
        `• *Model đang dùng:* \`${currentModel}\``,
        "",
        "*Các lệnh điều khiển:*",
        "• `/ask <câu hỏi>` — Hỏi AI trong nhóm chung (hoặc tag `@" + (botUsername || "bot") + "`, hoặc Reply tin nhắn của bot)",
        "• `/groupmode all` | `mention` — Bật trả lời mọi tin nhắn trong nhóm (`all`) hoặc chỉ khi được gọi (`mention`)",
        "• `/zaloqr` — Lấy mã QR quét kết nối tài khoản **Zalo cá nhân** làm Bot",
        "• `/zalomode dm` | `command` | `all` | `off` — Chỉnh chế độ tự trả lời trên Zalo",
        "• `/zalostatus` — Kiểm tra trạng thái kết nối Zalo cá nhân",
        "• `/setkey <key>` — Gắn API Key tạo trong Dashboard 9Router",
        "• `/models` — Hiện nút bấm chọn Model / Combo từ 9Router",
        "• `/model <tên_model>` — Nhập tay tên Model hoặc Combo",
        "• `/clear` — Xóa lịch sử hội thoại hiện tại",
        "• `/system <nội dung>` — Đặt System Prompt (`clear` để xóa)",
        "• `/backup` — Sao lưu ngay cấu hình 9Router lên GitHub Gist",
      ];
      await sendReply(chatId, lines.join("\n"), { parse_mode: "Markdown" }).catch(() =>
        sendReply(chatId, lines.join("\n").replace(/[*`]/g, ""))
      );
      return true;
    }

    if (cmd === "/zaloqr" || cmd === "/zalologin") {
      if (!zaloManager) {
        await sendReply(chatId, "⚠️ Module Zalo chưa được khởi tạo.");
        return true;
      }
      await sendReply(chatId, "⏳ Đang khởi tạo mã QR đăng nhập Zalo cá nhân, đợi 2 giây...");
      zaloManager
        .startQRLoginFlow({
          onQRImage: async (pngBuf) => {
            await sendPhotoBuffer(
              chatId,
              pngBuf,
              "📱 Mở app Zalo trên điện thoại -> Quét mã QR này để kết nối tài khoản Zalo cá nhân làm Bot!\n(Mã có hiệu lực trong ~60 giây)"
            );
          },
          onScanned: async (name) => {
            await sendReply(
              chatId,
              `👀 Đã nhận quét QR từ Zalo: ${name}!\n👉 Hãy bấm nút "Đăng nhập" trên màn hình điện thoại của bạn...`
            );
          },
          onSuccess: async ({ ownId, accountName }) => {
            await sendReply(
              chatId,
              `✅ Kết nối Zalo cá nhân thành công!\n• Tài khoản: ${accountName || ownId || "Đã kết nối"}\n• Chế độ Zalo hiện tại: ${zaloManager.getZaloMode()}\n• Đã tự động sao lưu phiên đăng nhập Zalo lên GitHub Secret Gist (không cần quét lại khi server restart)!\n\n💡 Mẹo: Gõ /zalomode command nếu chỉ muốn Bot trả lời trên Zalo khi có chữ /ask ở đầu, hoặc /zalomode dm để trả lời mọi tin nhắn 1-1.`
            );
          },
          onError: async (err) => {
            await sendReply(chatId, `⚠️ Phiên quét QR Zalo kết thúc: ${err.message}\nGõ /zaloqr để tạo mã mới.`);
          },
        })
        .catch((err) => sendReply(chatId, `⚠️ ${err.message}`));
      return true;
    }

    if (cmd === "/zalostatus") {
      if (!zaloManager) {
        await sendReply(chatId, "⚠️ Module Zalo chưa được khởi tạo.");
        return true;
      }
      const st = zaloManager.getStatus();
      await sendReply(
        chatId,
        `📱 Trạng thái Zalo cá nhân:\n• Kết nối: ${st.connected ? "✅ Đang hoạt động" : "❌ Chưa kết nối (gõ /zaloqr để quét mã)"}\n• Tên / UID: ${st.accountName || st.ownId || "(Chưa có)"}\n• Chế độ trả lời (/zalomode): ${st.mode}`
      );
      return true;
    }

    if (cmd === "/zalomode") {
      if (!zaloManager) {
        await sendReply(chatId, "⚠️ Module Zalo chưa được khởi tạo.");
        return true;
      }
      const m = argText.toLowerCase();
      if (!["dm", "command", "all", "off"].includes(m)) {
        await sendReply(
          chatId,
          `Chế độ Zalo hiện tại: ${zaloManager.getZaloMode()}\n\nCác chế độ hỗ trợ:\n• /zalomode dm — Trả lời mọi tin nhắn riêng 1-1; trong nhóm chỉ trả lời khi @Tag hoặc gõ /ask\n• /zalomode command — Chỉ trả lời khi tin nhắn có /ask hoặc /ai ở đầu (an toàn cho nick Zalo chính)\n• /zalomode all — Trả lời tất cả tin nhắn ở cả 1-1 và mọi nhóm Zalo\n• /zalomode off — Tạm tắt trả lời trên Zalo`
        );
        return true;
      }
      zaloManager.setZaloMode(m);
      await sendReply(chatId, `✅ Đã đổi chế độ trả lời Zalo sang: ${m}`);
      return true;
    }

    if (cmd === "/groupmode") {
      persisted.groupModes = persisted.groupModes || {};
      const mode = argText.toLowerCase();
      if (mode !== "all" && mode !== "mention") {
        const cur = persisted.groupModes[String(chatId)] || "mention";
        await sendReply(
          chatId,
          `Chế độ nhóm hiện tại: ${cur}\n• Gõ /groupmode all để Bot trả lời MỌI tin nhắn trong nhóm (nhớ tắt Privacy ở @BotFather hoặc cấp quyền Admin cho Bot).\n• Gõ /groupmode mention để chỉ trả lời khi tag @${botUsername || "bot"}, Reply tin nhắn của bot, hoặc gõ /ask.`
        );
        return true;
      }
      persisted.groupModes[String(chatId)] = mode;
      saveBotConfig(configPath, persisted);
      backupToCloud(dataDir).catch(() => {});
      await sendReply(
        chatId,
        mode === "all"
          ? "✅ Đã bật chế độ `all`: Bot sẽ trả lời mọi tin nhắn trong nhóm này!"
          : "✅ Đã bật chế độ `mention`: Bot chỉ trả lời khi được tag, Reply, hoặc dùng `/ask`."
      );
      return true;
    }

    if (cmd === "/clear" || cmd === "/new") {
      histories.delete(String(chatId));
      await sendReply(chatId, "🧹 Đã xóa lịch sử trò chuyện. Hãy bắt đầu chủ đề mới!");
      return true;
    }

    if (cmd === "/setkey") {
      if (!argText) {
        await sendReply(
          chatId,
          "Cách dùng: `/setkey <API_KEY_TRONG_DASHBOARD_9ROUTER>`\nVí dụ: `/setkey sk-9r-xxxxxx`"
        );
        return true;
      }
      persisted.routerApiKey = argText.trim();
      saveBotConfig(configPath, persisted);
      backupToCloud(dataDir).catch(() => {});
      await sendReply(
        chatId,
        "✅ Đã lưu API Key của 9Router! Gõ `/models` để chọn AI/Combo hoặc nhắn tin trực tiếp ngay."
      );
      return true;
    }

    if (cmd === "/model") {
      if (!argText) {
        const cur = getActiveModel(chatId) || "(Chưa đặt)";
        await sendReply(
          chatId,
          `Model hiện tại: ${cur}\nĐổi model bằng: /model <tên_model> hoặc gõ /models để chọn nút bấm.`
        );
        return true;
      }
      persisted.chatModels = persisted.chatModels || {};
      persisted.chatModels[String(chatId)] = argText.trim();
      persisted.defaultModel = argText.trim();
      saveBotConfig(configPath, persisted);
      backupToCloud(dataDir).catch(() => {});
      await sendReply(chatId, `✅ Đã chuyển sang model: ${argText.trim()}`);
      return true;
    }

    if (cmd === "/models") {
      try {
        const models = await fetchAvailableModels();
        if (models.length === 0) {
          await sendReply(
            chatId,
            "Chưa tìm thấy model nào từ `/v1/models`. Hãy kiểm tra bạn đã thêm Provider/Combo trong Dashboard 9Router chưa."
          );
          return true;
        }

        // Show top 24 models as inline buttons (only <= 60 bytes callback_data)
        const shown = models.filter((m) => Buffer.byteLength(`m:${m}`, "utf8") <= 64).slice(0, 24);
        const keyboard = [];
        for (let i = 0; i < shown.length; i += 2) {
          const row = [{ text: shown[i], callback_data: `m:${shown[i]}` }];
          if (shown[i + 1]) {
            row.push({ text: shown[i + 1], callback_data: `m:${shown[i + 1]}` });
          }
          keyboard.push(row);
        }

        const cur = getActiveModel(chatId) || "(Chưa chọn)";
        const extraNote =
          models.length > shown.length
            ? `\n(Hiển thị ${shown.length}/${models.length} model — bạn cũng có thể gõ /model <tên_model> bất kỳ)`
            : "";

        await sendReply(chatId, `🤖 Model hiện tại: ${cur}\nBấm chọn model bên dưới:${extraNote}`, {
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (err) {
        await sendReply(
          chatId,
          `⚠️ Không lấy được danh sách model: ${err.message}\nHãy kiểm tra đã gõ /setkey <API_KEY_9ROUTER> chưa.`
        );
      }
      return true;
    }

    if (cmd === "/system") {
      persisted.systemPrompts = persisted.systemPrompts || {};
      if (!argText) {
        const cur = getSystemPrompt(chatId) || "(Mặc định)";
        await sendReply(chatId, `System Prompt hiện tại:\n${cur}\n\nGõ /system clear để xóa.`);
        return true;
      }
      if (argText.toLowerCase() === "clear") {
        delete persisted.systemPrompts[String(chatId)];
        saveBotConfig(configPath, persisted);
        await sendReply(chatId, "✅ Đã xóa System Prompt về mặc định.");
        return true;
      }
      persisted.systemPrompts[String(chatId)] = argText;
      saveBotConfig(configPath, persisted);
      backupToCloud(dataDir).catch(() => {});
      await sendReply(chatId, "✅ Đã cập nhật System Prompt!");
      return true;
    }

    if (cmd === "/backup") {
      await sendReply(chatId, "⏳ Đang sao lưu cấu hình 9Router lên GitHub Secret Gist...");
      const res = await backupToCloud(dataDir, { force: true });
      if (res.ok) {
        await sendReply(
          chatId,
          `✅ Sao lưu thành công (${res.sizeKB || "?"} KB) lên Secret Gist ID: ${res.gistId}`
        );
      } else {
        await sendReply(chatId, `⚠️ Không thể sao lưu: ${res.reason}`);
      }
      return true;
    }

    return false;
  }

  async function handleChatMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    let text = (msg.text || msg.caption || "").trim();
    if (!text) return;

    if (!isAuthorized(userId)) {
      if (!isGroup) {
        await sendReply(chatId, `⛔ Bạn không có quyền sử dụng bot này (ID của bạn: ${userId}).`);
      }
      return;
    }

    // Handle /ask or /ai command in groups & private chat
    if (/^\/(ask|ai)(@\S+)?(\s+|$)/i.test(text)) {
      text = text.replace(/^\/(ask|ai)(@\S+)?\s*/i, "").trim();
      if (!text) {
        await sendReply(chatId, "Cách dùng: `/ask <nội dung câu hỏi>`", {
          reply_to_message_id: msg.message_id,
        });
        return;
      }
    } else if (text.startsWith("/")) {
      const handled = await handleCommand(msg, text);
      if (handled) return;
    } else if (isGroup) {
      const groupMode = (persisted.groupModes && persisted.groupModes[String(chatId)]) || "mention";
      const isReplyToBot = Boolean(botId && msg.reply_to_message?.from?.id === botId);
      const mentionRegex = botUsername ? new RegExp(`@${botUsername}\\b`, "i") : null;
      const isMentioned = Boolean(mentionRegex && mentionRegex.test(text));

      if (groupMode !== "all" && !isReplyToBot && !isMentioned) {
        return; // Ignore normal group chatter unless mentioned, replied to, or /groupmode all
      }

      if (isMentioned && mentionRegex) {
        text = text.replace(mentionRegex, "").trim();
        if (!text) return;
      }
    }

    const replyExtra = isGroup ? { reply_to_message_id: msg.message_id } : {};

    const apiKey = getApiKey();
    if (!apiKey) {
      await sendReply(
        chatId,
        "⚠️ Chưa có API Key kết nối 9Router!\n\n1. Vào trang quản trị 9Router mục Endpoint & Key để tạo API Key.\n2. Quay lại đây gõ:\n/setkey <API_KEY_CỦA_BẠN>",
        replyExtra
      );
      return;
    }

    const model = await ensureModelSelected(chatId);
    if (!model) {
      await sendReply(
        chatId,
        "⚠️ Chưa chọn Model/Combo nào! Hãy vào Dashboard 9Router gắn AI hoặc tạo Combo trước, sau đó gõ:\n/model <tên_model_hoặc_combo>",
        replyExtra
      );
      return;
    }

    const key = String(chatId);
    const history = histories.get(key) || [];
    history.push({ role: "user", content: text });
    while (history.length > MAX_HISTORY_MESSAGES) {
      history.shift();
    }
    histories.set(key, history);

    const sysPrompt = getSystemPrompt(chatId);
    const messages = sysPrompt
      ? [{ role: "system", content: sysPrompt }, ...history]
      : [...history];

    // Keep sending typing indicator while AI thinks
    tgCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const typingTimer = setInterval(() => {
      tgCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    }, 4000);

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
        throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 400)}`);
      }

      const data = JSON.parse(rawText);
      const replyContent =
        data?.choices?.[0]?.message?.content ||
        data?.content?.[0]?.text ||
        "(AI không trả về nội dung văn bản)";

      history.push({ role: "assistant", content: replyContent });
      while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
      }

      await sendReply(chatId, replyContent, replyExtra);
    } catch (err) {
      // Roll back failed user turn so context stays clean
      history.pop();
      await sendReply(chatId, `❌ Lỗi gọi 9Router (model: ${model}):\n${err.message}`, replyExtra);
    } finally {
      clearInterval(typingTimer);
    }
  }

  async function handleCallbackQuery(cb) {
    const chatId = cb.message?.chat?.id;
    const userId = cb.from?.id;
    const data = cb.data || "";

    if (!isAuthorized(userId)) {
      await tgCall("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Không có quyền truy cập",
        show_alert: true,
      }).catch(() => {});
      return;
    }

    if (data.startsWith("m:") && chatId) {
      const chosenModel = data.slice(2);
      persisted.chatModels = persisted.chatModels || {};
      persisted.chatModels[String(chatId)] = chosenModel;
      persisted.defaultModel = chosenModel;
      saveBotConfig(configPath, persisted);
      backupToCloud(dataDir).catch(() => {});

      await tgCall("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: `Đã chọn: ${chosenModel}`,
      }).catch(() => {});

      await sendReply(chatId, `✅ Đã chuyển sang model: ${chosenModel}`);
    }
  }

  async function pollLoop() {
    let offset = 0;
    try {
      await tgCall("deleteWebhook", { drop_pending_updates: false });
      const me = await tgCall("getMe");
      botUsername = me.username || "";
      botId = me.id || null;
      console.log(`[TeleBot] Started successfully as @${me.username} (connected to ${routerBase})`);
    } catch (err) {
      console.error("[TeleBot] Startup check failed (check TELEGRAM_BOT_TOKEN):", err.message);
    }

    while (running) {
      try {
        pollAbort = new AbortController();
        const updates = await tgCall(
          "getUpdates",
          {
            offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"],
          },
          pollAbort.signal
        );

        for (const upd of updates) {
          offset = upd.update_id + 1;
          if (upd.message) {
            handleChatMessage(upd.message).catch((e) =>
              console.error("[TeleBot] Message handler error:", e.message)
            );
          } else if (upd.callback_query) {
            handleCallbackQuery(upd.callback_query).catch((e) =>
              console.error("[TeleBot] Callback handler error:", e.message)
            );
          }
        }
      } catch (err) {
        if (!running) break;
        if (err.name !== "AbortError") {
          console.error("[TeleBot] Poll error (retrying in 5s):", err.message);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  pollLoop();

  return {
    stop() {
      running = false;
      if (pollAbort) {
        try { pollAbort.abort(); } catch {}
      }
    },
  };
}

module.exports = { startTelegramBot };

