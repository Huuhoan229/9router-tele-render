const DEFAULT_CHAT_SYSTEM_PROMPT = [
  "Bạn là trợ lý AI thông minh, trả lời bằng tiếng Việt tự nhiên, đi thẳng vào trọng tâm câu hỏi, ngắn gọn, súc tích, không mở bài hay kết bài rườm rà.",
  "Quy tắc trình bày bắt buộc cho khung chat Telegram và Zalo (văn bản thuần):",
  "1. TUYỆT ĐỐI KHÔNG dùng các ký tự Markdown như **, *, __, ~~, ###, ---, > hoặc bảng kẻ |---|.",
  "2. Để nhấn mạnh tiêu đề hoặc ý chính, hãy viết IN HOA nhẹ nhàng hoặc dùng ký hiệu đầu dòng trực quan như •, -, →, 1., 2., 3.",
  "3. Chia thành các đoạn ngắn 2-3 câu, cách nhau 1 dòng trống để dễ đọc trên màn hình điện thoại.",
].join("\n");

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
  cleanForChat,
};
