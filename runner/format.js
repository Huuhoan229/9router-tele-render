const DEFAULT_CHAT_SYSTEM_PROMPT = [
  "Bạn là trợ lý AI thông minh, trả lời bằng tiếng Việt tự nhiên, đi thẳng vào trọng tâm câu hỏi, ngắn gọn, súc tích, không mở bài hay kết bài rườm rà.",
  "Quy tắc trình bày bắt buộc cho khung chat Telegram và Zalo (văn bản thuần):",
  "1. TUYỆT ĐỐI KHÔNG dùng các ký tự Markdown như **, *, __, ~~, ###, ---, > hoặc bảng kẻ |---|.",
  "2. Để nhấn mạnh tiêu đề hoặc ý chính, hãy viết IN HOA nhẹ nhàng hoặc dùng ký hiệu đầu dòng trực quan như •, -, →, 1., 2., 3.",
  "3. Chia thành các đoạn ngắn 2-3 câu, cách nhau 1 dòng trống để dễ đọc trên màn hình điện thoại.",
].join("\n");

const DEFAULT_IMAGE_PROMPT =
  "Hãy xem bức ảnh này và trả lời trọng tâm nội dung trong ảnh bằng tiếng Việt (nếu là câu hỏi/bài tập thì giải chi tiết ngắn gọn, nếu là văn bản ngoại ngữ thì dịch hoặc giải thích ý chính, nếu là ảnh thường thì mô tả rõ trọng tâm).";

/**
 * Download an image URL and return a base64 Data URI (`data:image/jpeg;base64,...`).
 * Limits download size to 12 MB to protect Render Free 512MB RAM.
 */
async function downloadImageAsDataUrl(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: extraHeaders });
  if (!res.ok) {
    throw new Error(`Không tải được ảnh (HTTP ${res.status})`);
  }

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > 12 * 1024 * 1024) {
    throw new Error("Ảnh quá lớn (> 12MB), vui lòng gửi ảnh nhẹ hơn.");
  }

  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > 12 * 1024 * 1024) {
    throw new Error("Ảnh quá lớn (> 12MB), vui lòng gửi ảnh nhẹ hơn.");
  }

  let mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes(".png")) mime = "image/png";
    else if (lowerUrl.includes(".webp")) mime = "image/webp";
    else if (lowerUrl.includes(".gif")) mime = "image/gif";
    else mime = "image/jpeg";
  }

  const b64 = Buffer.from(arrayBuf).toString("base64");
  return `data:${mime};base64,${b64}`;
}

/**
 * Build OpenAI-compatible multimodal content array for 9Router `/v1/chat/completions`.
 */
function buildVisionContent(promptText, imageDataUrls) {
  const finalPrompt = (promptText || "").trim() || DEFAULT_IMAGE_PROMPT;
  if (!imageDataUrls || imageDataUrls.length === 0) {
    return finalPrompt;
  }
  const parts = [{ type: "text", text: finalPrompt }];
  for (const dataUrl of imageDataUrls) {
    parts.push({
      type: "image_url",
      image_url: { url: dataUrl },
    });
  }
  return parts;
}

/**
 * Strip stray Markdown formatting (**bold**, ### headers, etc.) outside fenced code blocks
 * so messages always look clean in plain-text Telegram & Zalo chats.
 */
function cleanForChat(text) {
  if (!text) return "";

  // Split by fenced code blocks ```...``` so we don't mangle actual source code
  const segments = String(text).split(/(```[\s\S]*?```)/g);

  return segments
    .map((seg) => {
      if (seg.startsWith("```") && seg.endsWith("```")) {
        // Strip only the opening/closing ``` backticks line for clean plain text display
        return seg
          .replace(/^```[^\n]*\n?/, "")
          .replace(/\n?```$/, "");
      }

      return seg
        // Headings ### Title -> TITLE or plain Title
        .replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "$1")
        // Bold/italic ***text***, **text**, __text__
        .replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1")
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/__([^_\n]+)__/g, "$1")
        // Markdown bullet * item -> • item
        .replace(/^[ \t]*\*[ \t]+/gm, "• ")
        // Inline `code` -> code
        .replace(/`([^`\n]+)`/g, "$1")
        // Horizontal rules --- or ***
        .replace(/^[ \t]*([-*_]){3,}[ \t]*$/gm, "")
        // Collapse 3+ blank lines to 2
        .replace(/\n{3,}/g, "\n\n");
    })
    .join("")
    .trim();
}

module.exports = {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_IMAGE_PROMPT,
  downloadImageAsDataUrl,
  buildVisionContent,
  cleanForChat,
};
