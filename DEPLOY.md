# Hướng dẫn triển khai GitHub Actions → GHCR → Portainer Stack

> **Bảo mật**: File `backend/.env` đã được chặn bởi cả `.gitignore` và `.dockerignore` nên **không bao giờ** bị đẩy lên Git hay đóng gói vào Docker image. Toàn bộ thông tin nhạy cảm (`DB_PASSWORD`, `ADMIN_PASSWORD`...) được nhập trực tiếp trong mục **Environment variables** của Portainer.

---

## Bước 1: Đẩy code lên GitHub (GitHub Actions tự build image lên GHCR)

```bash
git remote add origin https://github.com/<USERNAME>/<REPO>.git
git branch -M main
git push -u origin main
```

Sau khi push lên nhánh `main`:
1. Vào tab **Actions** trên GitHub → workflow **Build & Push Docker Image to GHCR** sẽ tự chạy `npm test`, build `Dockerfile` và đẩy image lên:
   `ghcr.io/<username>/<repo>:latest` (lưu ý `<username>/<repo>` viết thường).
2. Kiểm tra image tại mục **Packages** trên GitHub:
   - Nếu repo Private và muốn Portainer kéo image không cần token: mở Package → **Package settings** → đổi visibility thành **Public** (hoặc giữ Private và làm Bước 2a).

---

## Bước 2: Triển khai Stack trên Portainer

### 2a. Nếu GHCR Package là Private (bỏ qua nếu Public)
1. Trên GitHub: **Settings → Developer settings → Personal access tokens (classic)** → tạo token có quyền `read:packages`.
2. Trên Portainer: **Registries → Add registry → Custom registry**:
   - **Name**: `GHCR`
   - **Registry URL**: `ghcr.io`
   - **Authentication**: bật, nhập GitHub username + token vừa tạo.

### 2b. Tạo Stack trên Portainer
1. Vào **Stacks → Add stack** → đặt tên (VD: `lamdong-map`).
2. Dán nội dung file `docker-compose.portainer.yml` vào **Web editor**.
3. Kéo xuống mục **Environment variables** → bấm **Add an environment variable** (hoặc chuyển sang **Advanced mode** rồi dán mẫu sau và điền mật khẩu thực):

```env
IMAGE_NAME=ghcr.io/<username>/<repo>:latest
APP_PORT=3000
DB_HOST=10.61.200.10
DB_PORT=1433
DB_USER=sa
DB_PASSWORD=<mat_khau_sql_server>
DB_NAME=getjson
DB_ENCRYPT=false
ADMIN_USER=lamdong
ADMIN_PASSWORD=<mat_khau_admin>
PUBLIC_BASE_URL=http://<ip-hoac-domain-server>:3000
```

4. Bấm **Deploy the stack**.

---

## Bước 3 (Tùy chọn): Tự động cập nhật Portainer mỗi khi `git push`
1. Trong Stack trên Portainer, bật **Stack webhook** (hoặc **Service webhook**) và copy URL webhook.
2. Trên GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `PORTAINER_WEBHOOK_URL`
   - Value: dán URL webhook từ Portainer.
3. Từ lần push sau, GitHub Actions sẽ tự build image mới lên GHCR và gọi webhook để Portainer tự pull & khởi động lại container.
