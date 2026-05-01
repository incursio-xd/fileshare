require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const cron = require("node-cron");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { fromBuffer } = require("file-type");
const { supabase, initDB } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const BUCKET = process.env.SUPABASE_BUCKET || "fileshare";
const EXPIRY_HOURS = parseInt(process.env.FILE_EXPIRY_HOURS || "2", 10);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".sh", ".bat", ".ps1", ".msi", ".cmd", ".vbs",
  ".js", ".jar", ".py", ".rb", ".php", ".dll", ".so",
]);

const BLOCKED_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-sh",
  "application/x-bat",
  "application/x-msi",
  "application/java-archive",
]);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "10kb" }));

app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many uploads, try again later." },
});

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many attempts, try again later." },
});

const infoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: "Too many requests." },
});

function sanitizeFilename(filename) {
  return path
    .basename(filename)
    .replace(/[^a-zA-Z0-9.\-_]/g, "_")
    .slice(0, 200);
}

async function validateFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return "File type not allowed.";
  }

  if (BLOCKED_MIME_TYPES.has(file.mimetype)) {
    return "File type not allowed.";
  }

  const detected = await fromBuffer(file.buffer);
  if (detected && BLOCKED_MIME_TYPES.has(detected.mime)) {
    return "File type not allowed.";
  }

  return null;
}

async function getAttempts(token) {
  const { data } = await supabase
    .from("download_attempts")
    .select("attempts, locked_until")
    .eq("token", token)
    .single();
  return data;
}

async function recordAttempt(token, success) {
  const existing = await getAttempts(token);

  if (!existing) {
    await supabase.from("download_attempts").insert({
      token,
      attempts: success ? 0 : 1,
      locked_until: null,
    });
    return { locked: false, remaining: 4 };
  }

  if (success) {
    await supabase
      .from("download_attempts")
      .update({ attempts: 0, locked_until: null })
      .eq("token", token);
    return { locked: false, remaining: 5 };
  }

  const newAttempts = existing.attempts + 1;
  const locked = newAttempts >= 5;
  const lockedUntil = locked
    ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
    : null;

  await supabase
    .from("download_attempts")
    .update({ attempts: newAttempts, locked_until: lockedUntil })
    .eq("token", token);

  return { locked, remaining: Math.max(0, 5 - newAttempts) };
}

async function logAudit(token, ip, success, note = "") {
  await supabase.from("audit_log").insert({
    token,
    ip,
    success,
    note,
  });
}

app.post("/api/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  try {
    const { password } = req.body;

    if (!req.file) return res.status(400).json({ error: "No file provided" });
    if (!password || password.trim() === "")
      return res.status(400).json({ error: "Password is required" });

    const validationError = await validateFile(req.file);
    if (validationError) return res.status(400).json({ error: validationError });

    const safeFilename = sanitizeFilename(req.file.originalname);
    const token = uuidv4();
    const storagePath = `${token}/${safeFilename}`;
    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      return res.status(500).json({ error: "Failed to upload file to storage" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { error: dbError } = await supabase.from("files").insert({
      token,
      filename: safeFilename,
      storage_path: storagePath,
      password_hash: passwordHash,
      expires_at: expiresAt.toISOString(),
      downloaded: false,
    });

    if (dbError) {
      console.error("DB insert error:", dbError);
      await supabase.storage.from(BUCKET).remove([storagePath]);
      return res.status(500).json({ error: "Failed to save file metadata" });
    }

    return res.json({ token, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error("Upload route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/download/:token", downloadLimiter, async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  const ip = req.ip;

  try {
    if (!password)
      return res.status(400).json({ error: "Password is required" });

    const attemptData = await getAttempts(token);
    if (
      attemptData?.locked_until &&
      new Date() < new Date(attemptData.locked_until)
    ) {
      await logAudit(token, ip, false, "locked_out");
      return res.status(429).json({
        error: "Too many failed attempts. Try again in 15 minutes.",
      });
    }

    const { data, error } = await supabase
      .from("files")
      .select("*")
      .eq("token", token)
      .single();

    if (error || !data) {
      await logAudit(token, ip, false, "not_found");
      return res.status(404).json({ error: "File not found or link expired" });
    }

    if (new Date() > new Date(data.expires_at)) {
      await logAudit(token, ip, false, "expired");
      return res.status(410).json({ error: "This link has expired" });
    }

    if (data.downloaded) {
      await logAudit(token, ip, false, "already_downloaded");
      return res.status(410).json({ error: "This file has already been downloaded" });
    }

    const passwordMatch = await bcrypt.compare(password, data.password_hash);
    if (!passwordMatch) {
      const { locked, remaining } = await recordAttempt(token, false);
      await logAudit(token, ip, false, "wrong_password");
      if (locked) {
        return res.status(429).json({
          error: "Too many failed attempts. Link locked for 15 minutes.",
        });
      }
      return res.status(401).json({
        error: `Incorrect password. ${remaining} attempt(s) remaining.`,
      });
    }

    const { data: signedData, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(data.storage_path, 15, {
        download: data.filename,
      });

    if (signError || !signedData?.signedUrl) {
      console.error("Signed URL error:", signError);
      return res.status(500).json({ error: "Could not generate download link" });
    }

    await supabase
      .from("files")
      .update({ downloaded: true })
      .eq("token", token);

    await recordAttempt(token, true);
    await logAudit(token, ip, true, "downloaded");

    return res.json({
      url: signedData.signedUrl,
      filename: data.filename,
      expiresAt: data.expires_at,
    });
  } catch (err) {
    console.error("Download route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/info/:token", infoLimiter, async (req, res) => {
  try {
    const { token } = req.params;

    const { data, error } = await supabase
      .from("files")
      .select("filename, expires_at, downloaded")
      .eq("token", token)
      .single();

    if (error || !data)
      return res.status(404).json({ error: "File not found or link expired" });

    if (new Date() > new Date(data.expires_at))
      return res.status(410).json({ error: "This link has expired" });

    if (data.downloaded)
      return res.status(410).json({ error: "This file has already been downloaded" });

    return res.json({ filename: data.filename, expiresAt: data.expires_at });
  } catch (err) {
    console.error("Info route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  res.status(500).json({ error: "Internal server error" });
});

cron.schedule("*/15 * * * *", async () => {
  try {
    const { data: expiredFiles, error } = await supabase
      .from("files")
      .select("id, token, storage_path")
      .lt("expires_at", new Date().toISOString());

    if (error || !expiredFiles?.length) return;

    const paths = expiredFiles.map((f) => f.storage_path);
    await supabase.storage.from(BUCKET).remove(paths);

    const ids = expiredFiles.map((f) => f.id);
    const tokens = expiredFiles.map((f) => f.token);
    await supabase.from("files").delete().in("id", ids);
    await supabase.from("download_attempts").delete().in("token", tokens);

    console.log(`Cron: deleted ${expiredFiles.length} expired file(s).`);
  } catch (err) {
    console.error("Cron job error:", err);
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});