const fs = require("fs");
const path = require("path");
const { backupToCloud } = require("./backup");

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

function startTelegramBot({ port, dataDir }) {
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
    const text = (msg.text || "").trim();
    if (!text) return;

    if (!isAuthorized(userId)) {
      await sendReply(chatId, `⛔ Bạn không có quyền sử dụng bot này (ID của bạn: ${userId}).`);
      return;
    }

    if (text.startsWith("/")) {
      const handled = await handleCommand(msg, text);
      if (handled) return;
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      await sendReply(
        chatId,
        "⚠️ Chưa có API Key kết nối 9Router!\n\n1. Vào trang quản trị 9Router mục Endpoint & Key để tạo API Key.\n2. Quay lại đây gõ:\n/setkey <API_KEY_CỦA_BẠN>"
      );
      return;
    }

    const model = await ensureModelSelected(chatId);
    if (!model) {
      await sendReply(
        chatId,
        "⚠️ Chưa chọn Model/Combo nào! Hãy vào Dashboard 9Router gắn AI hoặc tạo Combo trước, sau đó gõ:\n/model <tên_model_hoặc_combo>"
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

      await sendReply(chatId, replyContent);
    } catch (err) {
      // Roll back failed user turn so context stays clean
      history.pop();
      await sendReply(chatId, `❌ Lỗi gọi 9Router (model: ${model}):\n${err.message}`);
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

