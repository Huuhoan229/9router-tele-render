/**
 * Script tiện ích chạy trên máy Windows của bạn:
 * Nén toàn bộ cấu hình 9Router sẵn có ở C:\Users\Admin\AppData\Roaming\9router
 * (tự động lọc bỏ log lịch sử nặng 500MB+, chỉ giữ lại ~70KB cấu hình AI, OAuth token, Combo, API Key)
 * và đẩy thẳng lên Secret GitHub Gist của bạn để Render tự động nhận ngay khi khởi động!
 *
 * Cách chạy:
 *   $env:GITHUB_TOKEN="ghp_xxxxx"; node sync-local-to-cloud.js
 */

const path = require("path");
const os = require("os");
const { backupToCloud } = require("./runner/backup");

async function run() {
  const token = (process.env.GITHUB_TOKEN || process.argv[2] || "").trim();
  if (!token) {
    console.error("❌ Thiếu GITHUB_TOKEN!");
    console.error("Cách chạy trong PowerShell:");
    console.error('  node sync-local-to-cloud.js ghp_TokenCuaBan');
    process.exit(1);
  }

  const localDataDir =
    process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "9router")
      : path.join(os.homedir(), ".9router");

  console.log(`📦 Đang đọc và nén cấu hình 9Router từ: ${localDataDir} ...`);
  const res = await backupToCloud(localDataDir, { token, force: true });

  if (res.ok) {
    console.log(`✅ Đẩy cấu hình lên GitHub Secret Gist thành công!`);
    console.log(`   • Dung lượng sau nén: ${res.sizeKB} KB`);
    console.log(`   • Gist ID: ${res.gistId}`);
    console.log(`👉 Giờ khi bạn điền cùng GITHUB_TOKEN này trên Render, server Render sẽ có sẵn 100% các AI, OAuth Token và Combo y hệt trên máy bạn!`);
  } else {
    console.error(`❌ Lỗi sao lưu: ${res.reason}`);
    process.exit(1);
  }
}

run();
