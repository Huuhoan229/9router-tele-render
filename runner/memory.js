const fs = require("fs");
const path = require("path");

const MAX_TURNS_MESSAGES = 30; // 15 full Q&A pairs per chat
const MAX_ACTIVE_THREADS = 80; // Cap total saved threads to keep JSON tiny

function createMemoryStore(dataDir) {
  const filePath = path.join(dataDir, "chat-histories.json");
  let store = {}; // threadKey -> { updatedAt: number, messages: Array<{ role, content }> }
  let saveTimer = null;

  // Load existing histories from disk on startup
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        store = parsed;
      }
    }
  } catch (err) {
    console.error("[Memory] Failed to load chat-histories.json:", err.message);
  }

  function flushToDisk() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      // Prune oldest threads if exceeding MAX_ACTIVE_THREADS
      const keys = Object.keys(store);
      if (keys.length > MAX_ACTIVE_THREADS) {
        keys
          .sort((a, b) => (store[b]?.updatedAt || 0) - (store[a]?.updatedAt || 0))
          .slice(MAX_ACTIVE_THREADS)
          .forEach((k) => delete store[k]);
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(store), "utf8");
    } catch (err) {
      console.error("[Memory] Failed to write chat-histories.json:", err.message);
    }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(flushToDisk, 1500);
  }

  /**
   * Return a clean, strictly alternating [user, assistant, user, ...] array
   * ready to append the current user message for LLM request.
   */
  function getHistoryForRequest(threadKey) {
    const entry = store[String(threadKey)];
    const raw = Array.isArray(entry?.messages) ? entry.messages : [];
    const cleaned = [];

    for (const item of raw) {
      if (!item || (item.role !== "user" && item.role !== "assistant")) continue;
      const text = typeof item.content === "string" ? item.content.trim() : "";
      if (!text) continue;

      if (cleaned.length === 0) {
        // History must always begin with a 'user' message (required by Claude/Gemini)
        if (item.role !== "user") continue;
        cleaned.push({ role: "user", content: text });
      } else if (cleaned[cleaned.length - 1].role === item.role) {
        // Merge consecutive messages of the same role
        cleaned[cleaned.length - 1].content += `\n${text}`;
      } else {
        cleaned.push({ role: item.role, content: text });
      }
    }

    // If last saved item was somehow 'user' without an assistant reply, merge or drop trailing orphan
    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === "user") {
      cleaned.pop();
    }

    return cleaned;
  }

  /**
   * Append a completed (userText, assistantText) turn and persist to disk.
   */
  function appendCompletedTurn(threadKey, userTextForHistory, assistantText) {
    const key = String(threadKey);
    const current = getHistoryForRequest(key);

    current.push(
      { role: "user", content: String(userTextForHistory || "").trim() },
      { role: "assistant", content: String(assistantText || "").trim() }
    );

    // Trim in pairs so index 0 is ALWAYS 'user'
    while (current.length > MAX_TURNS_MESSAGES) {
      current.shift();
    }
    while (current.length > 0 && current[0].role !== "user") {
      current.shift();
    }

    store[key] = {
      updatedAt: Date.now(),
      messages: current,
    };
    scheduleSave();
  }

  function clearThread(threadKey) {
    delete store[String(threadKey)];
    flushToDisk();
  }

  function getMessageCount(threadKey) {
    return getHistoryForRequest(threadKey).length;
  }

  return {
    getHistoryForRequest,
    appendCompletedTurn,
    clearThread,
    getMessageCount,
    flushToDisk,
  };
}

module.exports = { createMemoryStore };
