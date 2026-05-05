# File-To-Link Uploader

Browser-based uploader with admin auth, share links, and upload history.

This project includes:
1. A frontend admin UI (static files).
2. A backend API implementation for Netlify Functions + Netlify Blobs.
3. A frontend config layer so the same UI can be pointed to non-Netlify backends too.

## Features
1. Upload a file or folder (folder uploads are zipped in-browser).
2. Generate tokenized download links.
3. Admin-only history page with metrics and pagination.
4. Revoke link, or delete link + underlying file.
5. Idempotent uploads to avoid duplicate records on retries.

## Frontend Configuration (Any Provider)
Frontend API and route mapping is centralized in [app-config.js](app-config.js).

Default settings target Netlify Functions:
1. `ENDPOINT_ADMIN_AUTH` -> `/.netlify/functions/admin-auth`
2. `ENDPOINT_UPLOAD` -> `/.netlify/functions/upload`
3. `ENDPOINT_HISTORY` -> `/.netlify/functions/history`

To use another provider/backend, update values in [app-config.js](app-config.js):
1. Set `API_BASE_URL` (optional, for separate API origin).
2. Set endpoint paths or absolute URLs (`ENDPOINT_*`).
3. Optionally customize UI routes (`ROUTE_ADMIN`, `ROUTE_HISTORY`).

## Backend API Contract (For Non-Netlify Backends)
If you deploy backend elsewhere, keep these endpoints compatible:

1. `GET admin-auth`
2. `POST admin-auth` with JSON `{ username, password }`
3. `DELETE admin-auth`
4. `POST upload` with multipart form data:
  - `file`
  - optional `downloadName`
  - optional `idempotencyKey`
  - optional header `x-idempotency-key`
5. `GET history?limit=<n>&cursor=<cursor>`
6. `DELETE history` with JSON `{ token, indexKey, deleteFile }`

Expected response shape:
1. Success: JSON payload with relevant fields (`url`, `items`, `metrics`, etc).
2. Error: JSON `{ error: "message" }` with HTTP status.

## Deploy On Netlify (Current Backend)
1. Create a Netlify site from this folder.
2. Build command: empty (or `npm run build`).
3. Publish directory: `.`
4. Functions directory: `netlify/functions` (already in [netlify.toml](netlify.toml)).
5. Environment variables:
  - `ADMIN_USERNAME=Admin`
  - `ADMIN_PASSWORD=admin`
  - optional `MAX_STORAGE_MB=1024` for estimated space-left metric

## Local Run
```bash
npm install
npx netlify dev
```

Open `http://localhost:8888`.

## Data Stores Used By Netlify Backend
1. `uploaded-files`
2. `shared-links`
3. `uploads-index`
4. `upload-idempotency`
5. `upload-stats`
6. `admin-sessions`

## Notes And Limits
1. Current architecture uploads through a serverless function.
2. Practical request size threshold in local benchmark was about 5 MB (6 MB hit 413).
3. For very large files, migrate upload path to direct multipart object storage uploads.
