# SecureXfer — Secure One-Time File Sharing

A secure, one-time file sharing service. Person 1 uploads a file and sets a password → gets a shareable link → Person 2 enters the password and downloads the file. Links expire after 2 hours and each file can only be downloaded **once**.

---

## Features

- 🔒 **Password-protected downloads** — bcrypt hashed, never stored in plaintext
- 📁 **One-time links** — file marked as consumed after first successful download
- ⏰ **Auto-expiry** — files and storage objects cleaned up every 15 minutes via cron
- 🛡️ **Brute-force protection** — 5 failed attempts triggers a 15-minute lockout
- 🚫 **Executable blocking** — magic-byte MIME validation rejects `.exe`, `.sh`, `.bat`, `.py`, `.jar` and more
- 📝 **Audit logging** — every download attempt (success or failure) logged with IP
- 🔗 **Signed URLs** — 15-second expiring Supabase signed URLs for actual file delivery
- 🪖 **Helmet + Rate limiting** — hardened HTTP headers and per-route request limits

---

## Project Structure

```
fileshare/
├── backend/
│   ├── server.js        ← Express API (upload, download, info routes)
│   ├── db.js            ← Supabase client + DB init check
│   ├── package.json
│   └── .env             ← You create this (see Step 5)
└── frontend/
    ├── index.html       ← Upload page (Person 1)
    └── download.html    ← Download page (Person 2)
```

---

## Setup Guide

### Step 1 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up (free tier is sufficient)
2. Click **New Project**, give it a name, set a DB password, choose a region
3. Wait for provisioning (~1 minute)

---

### Step 2 — Create the Storage Bucket

1. In your Supabase project, go to **Storage** in the left sidebar
2. Click **New Bucket**
3. Name it: `fileshare`
4. Set it to **Private** (NOT public)
5. Click **Save**

---

### Step 3 — Create the Database Tables

Go to **SQL Editor** in the left sidebar, paste and run the following:

```sql
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text UNIQUE NOT NULL,
  filename      text NOT NULL,
  storage_path  text NOT NULL,
  password_hash text NOT NULL,
  expires_at    timestamptz NOT NULL,
  downloaded    boolean DEFAULT false,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE download_attempts (
  token         text PRIMARY KEY,
  attempts      int DEFAULT 0,
  locked_until  timestamptz
);

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token      text NOT NULL,
  ip         text,
  success    boolean NOT NULL,
  note       text,
  created_at timestamptz DEFAULT now()
);
```

---

### Step 4 — Get Your API Keys

1. Go to **Project Settings → API**
2. Copy:
   - **Project URL** — looks like `https://xxxx.supabase.co`
   - **service_role key** — under "Project API keys" (use `service_role`, NOT `anon`)

---

### Step 5 — Configure the Backend

```bash
cd fileshare/backend
npm install
```

Create a `.env` file:

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here
SUPABASE_BUCKET=fileshare
PORT=3000
FILE_EXPIRY_HOURS=2
FRONTEND_ORIGIN=http://localhost:3000
```

---

### Step 6 — Run the Server

```bash
node server.js
```

Expected output:
```
✅  Supabase DB connection OK
Server running at http://localhost:3000
```

---

### Step 7 — Use the App

**Person 1 (Uploader):** Open `http://localhost:3000`
- Select a file, set a password, click **Upload**
- Copy the generated link and share it with Person 2
- Share the password **separately** (e.g. via a different channel)

**Person 2 (Downloader):** Open the link received
- Enter the password, click **Download**
- The link is permanently expired after one successful download

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload a file with a password |
| `GET` | `/api/info/:token` | Get filename and expiry for a token |
| `POST` | `/api/download/:token` | Verify password and get signed download URL |

---

## Security Details

| Concern | Implementation |
|--------|----------------|
| Password storage | bcrypt (10 rounds) |
| File type validation | Extension blocklist + magic-byte MIME detection via `file-type` |
| Brute force | 5 attempts → 15-minute lockout per token |
| Download URL lifetime | 15-second Supabase signed URL |
| HTTP hardening | `helmet` with strict CSP |
| Rate limiting | 20 uploads / 10 downloads / 60 info requests per 15 min per IP |
| Audit trail | Every attempt logged with IP, token, result, and reason |

---

## Blocked File Types

`.exe` `.sh` `.bat` `.ps1` `.msi` `.cmd` `.vbs` `.js` `.jar` `.py` `.rb` `.php` `.dll` `.so`

Magic-byte validation also catches disguised executables regardless of extension.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `FILE_EXPIRY_HOURS` | `2` | Hours until a file link expires |
| `SUPABASE_BUCKET` | `fileshare` | Supabase storage bucket name |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Allowed CORS origin |

Max file size is **100 MB** — change the `limits.fileSize` value in `server.js` if needed.

---

## Exposing Beyond Localhost

Use [ngrok](https://ngrok.com) to share over the internet:

```bash
ngrok http 3000
```

Update `FRONTEND_ORIGIN` in `.env` to the ngrok URL before restarting the server.
