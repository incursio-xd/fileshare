# FileShare MVP

A simple file sharing app. Person 1 uploads a file + sets a password → gets a link → shares link + password with Person 2 → Person 2 enters password and downloads. Files auto-delete after 2 hours.

---

## Project Structure

```
fileshare/
├── backend/
│   ├── server.js        ← Express API
│   ├── db.js            ← Supabase client
│   ├── package.json
│   └── .env             ← You create this (see below)
└── frontend/
    ├── index.html       ← Upload page (Person 1)
    └── download.html    ← Download page (Person 2)
```

---

## Step 1 — Create a Supabase Project

1. Go to https://supabase.com and sign up (free)
2. Click **New Project**, give it a name, set a DB password, choose a region
3. Wait for it to provision (~1 min)

---

## Step 2 — Create the Storage Bucket

1. In your Supabase project, go to **Storage** in the left sidebar
2. Click **New Bucket**
3. Name it: `fileshare`
4. Set it to **Private** (NOT public)
5. Click **Save**

---

## Step 3 — Create the Database Table

1. Go to **SQL Editor** in the left sidebar
2. Paste and run this SQL:

```sql
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text UNIQUE NOT NULL,
  filename      text NOT NULL,
  storage_path  text NOT NULL,
  password_hash text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz DEFAULT now()
);
```

---

## Step 4 — Get Your API Keys

1. Go to **Project Settings** → **API** in the left sidebar
2. Copy:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **service_role** key (under "Project API keys" — use service_role, NOT anon)

---

## Step 5 — Set Up the Backend

```bash
cd fileshare/backend
npm install
```

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here
SUPABASE_BUCKET=fileshare
PORT=3000
FILE_EXPIRY_HOURS=2
```

---

## Step 6 — Run the Server

```bash
cd fileshare/backend
node server.js
```

You should see:
```
✅  Supabase DB connection OK
🚀  Server running at http://localhost:3000
```

---

## Step 7 — Use the App

- **Person 1 (Upload):** Open http://localhost:3000 in browser
  - Select a file, type a password, click Upload
  - Copy the generated link and share it + the password with Person 2

- **Person 2 (Download):** Open the link they received
  - Enter the password, click Download

---

## Notes

- Max file size: **100 MB** (change in `server.js` if needed)
- Files auto-delete every **15 minutes** via cron (only expired ones)
- The signed download URL is valid for **60 seconds** after clicking Download — enough to trigger the browser download
- If you want to expose this beyond localhost, use [ngrok](https://ngrok.com): `ngrok http 3000`
