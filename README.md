# 9Router + Telegram AI Chatbox on Render

Bộ project đóng gói chung **`decolua/9router:latest`** + **Telegram Bot** + **Tự động giữ cấu hình qua GitHub Secret Gist** chạy gọn trong **1 Docker Web Service Free duy nhất** trên Render.

---

## 1. Chuẩn bị 2 mã Token (mất 1 phút)

1. **`TELEGRAM_BOT_TOKEN`**:
   * Mở Telegram chat với `@BotFather` -> gõ `/newbot` -> đặt tên -> copy mã Token (dạng `123456789:AAH...`).
2. **`GITHUB_TOKEN`** *(giúp không bao giờ mất cấu hình AI & OAuth token khi Render restart hoặc khi bạn Update `9router`)*:
   * Vào GitHub -> [https://github.com/settings/tokens/new](https://github.com/settings/tokens/new)
   * Đặt tên bất kỳ, chọn **Expiration: No expiration**, tích chọn ô **`gist`** -> bấm **Generate token** -> copy mã `ghp_...`.

*(Tùy chọn cực tiện)*: Nếu bạn muốn mang **toàn bộ AI, OAuth token và Combo đang chạy sẵn trên máy tính** của bạn lên thẳng Render mà không cần cài lại từ đầu, mở PowerShell tại thư mục này chạy đúng 1 lệnh:
```powershell
node sync-local-to-cloud.js ghp_MaTokenGitHubCuaBan
```

---

## 2. Đẩy code lên GitHub & Deploy tự động lên Render (`render.yaml`)

### Bước A: Đẩy thư mục này lên 1 Repo trên GitHub của bạn
Tạo 1 repository trống trên GitHub (ví dụ `9router-tele-render`, để Public hay Private đều được), rồi chạy trong thư mục `d:\100MSDCF\9router-tele-render`:
```powershell
git init
git add .
git commit -m "Init 9Router + Telegram Bot for Render"
git branch -M main
git remote add origin https://github.com/<TEN_GITHUB_CUA_BAN>/9router-tele-render.git
git push -u origin main
```

### Bước B: Deploy 1-Click bằng Blueprint trên Render
1. Đăng nhập [https://dashboard.render.com](https://dashboard.render.com) bằng GitHub.
2. Bấm nút **New +** (góc trên bên phải) -> chọn **Blueprint**.
3. Kết nối tới repo `9router-tele-render` vừa đẩy lên.
4. Render tự đọc file `render.yaml` và hỏi bạn điền:
   * `INITIAL_PASSWORD`: Mật khẩu quản trị trang Dashboard 9Router của bạn.
   * `TELEGRAM_BOT_TOKEN`: Token lấy từ `@BotFather`.
   * `ALLOWED_TELEGRAM_IDS`: có thể để trống trong lần deploy đầu để lấy ID bằng lệnh `/start`; sau đó thêm ID của bạn vào biến này trong Render rồi deploy lại.
   * `GITHUB_TOKEN`: Mã `ghp_...` tạo ở mục 1.
5. Bấm **Apply / Deploy**! Đợi ~2 phút báo **Live** là bạn có link dạng `https://9router-tele-bot-xxxx.onrender.com`.

---

## 3. Kết nối AI & Chat trên Telegram

1. Mở `https://<ten-app-cua-ban>.onrender.com/dashboard`, đăng nhập bằng `INITIAL_PASSWORD`.
2. Vào mục **Endpoint & Key** -> tạo **API Key** (nếu bạn chưa đồng bộ từ máy lên thì gắn thêm AI Provider / Combo bạn muốn).
3. Mở con Bot của bạn trên Telegram:
   * Gõ `/setkey <API_KEY_9ROUTER>` (lưu vĩnh viễn, không cần restart Render).
   * Gõ `/setendpoint https://your-openai-compatible-host/v1` nếu muốn dùng endpoint AI khác. Kiểm tra bằng `/endpoint`.
   * Gõ `/model <model-name>` để đặt model thủ công, hoặc dùng `/models` để chọn.
   * Gõ `/models` -> **Bấm nút chọn thẳng Model / Combo** ngay trên màn hình chat Telegram!
   * Bắt đầu nhắn tin chat với AI qua `9Router`!

---

## 4. Render Free sleep và giới hạn giờ

Render Free tự sleep sau 15 phút không có request web đến service. Ping URL mỗi 10 phút có thể giữ service hoạt động:
1. Vào [https://cron-job.org](https://cron-job.org) (miễn phí, đăng ký 15 giây).
2. Bấm **Create Cronjob**:
   * **URL:** `https://<ten-app-cua-ban>.onrender.com/`
   * **Execution schedule:** Every **10 minutes**.
3. Lưu lại. Lặp lại bước này cho service bridge Zalo nếu muốn service đó cũng được đánh thức thường xuyên.

Lưu ý: Render cấp 750 giờ Free cho cả workspace mỗi tháng. Nếu bạn giữ cả bot này và bridge Zalo chạy liên tục, hai service cần khoảng 1.500 giờ/tháng; một workspace Free không đủ chạy cả hai 24/7. Nếu service sleep, Telegram polling và Zalo listener cũng dừng cho đến khi có request đánh thức service.

Đặt `ALLOWED_TELEGRAM_IDS` bằng Telegram user ID của bạn để bật sử dụng bot và giới hạn ai có thể thay endpoint, key, model. Khi danh sách để trống, chỉ `/start` và `/help` hoạt động để người dùng xem ID của mình.

---

## 5. Cách Update `9Router` lên phiên bản mới nhất

Khi `9router` có bản cập nhật mới:
1. *(An toàn tuyệt đối)* Gõ `/backup` trên Telegram để ép lưu cấu hình mới nhất lên GitHub Gist.
2. Vào Dashboard của Render -> chọn service `9router-tele-bot` -> bấm **Manual Deploy** -> **Clear build cache & deploy**.
3. Render sẽ tự động kéo bản `decolua/9router:latest` mới nhất về và tự khôi phục 100% tài khoản AI, OAuth token, Combo của bạn!

