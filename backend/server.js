require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const cron = require("node-cron");
const path = require("path");
const { supabase, initDB } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const BUCKET = process.env.SUPABASE_BUCKET || "fileshare";
const EXPIRY_HOURS = parseInt(process.env.FILE_EXPIRY_HOURS || "2", 10);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve the frontend HTML files from ../frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// Multer: store upload in memory (we stream straight to Supabase)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/upload
 * Body: multipart/form-data  { file, password }
 * Returns: { token, expiresAt }
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const { password } = req.body;

    if (!req.file) return res.status(400).json({ error: "No file provided" });
    if (!password || password.trim() === "")
      return res.status(400).json({ error: "Password is required" });

    const token = uuidv4();
    const storagePath = `${token}/${req.file.originalname}`;
    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000);

    // 1. Upload file buffer to Supabase Storage
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

    // 2. Hash the password
    const passwordHash = await bcrypt.hash(password, 10);

    // 3. Save metadata to DB
    const { error: dbError } = await supabase.from("files").insert({
      token,
      filename: req.file.originalname,
      storage_path: storagePath,
      password_hash: passwordHash,
      expires_at: expiresAt.toISOString(),
    });

    if (dbError) {
      console.error("DB insert error:", dbError);
      // Rollback: delete the uploaded file
      await supabase.storage.from(BUCKET).remove([storagePath]);
      return res.status(500).json({ error: "Failed to save file metadata" });
    }

    return res.json({
      token,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error("Upload route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/download/:token
 * Body: { password }
 * Returns: signed download URL (valid 60 seconds)
 */
app.post("/api/download/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password)
      return res.status(400).json({ error: "Password is required" });

    // 1. Fetch record from DB
    const { data, error } = await supabase
      .from("files")
      .select("*")
      .eq("token", token)
      .single();

    if (error || !data)
      return res.status(404).json({ error: "File not found or link expired" });

    // 2. Check expiry
    if (new Date() > new Date(data.expires_at))
      return res.status(410).json({ error: "This link has expired" });

    // 3. Verify password
    const passwordMatch = await bcrypt.compare(password, data.password_hash);
    if (!passwordMatch)
      return res.status(401).json({ error: "Incorrect password" });

    // 4. Generate a short-lived signed URL (60 seconds)
    const { data: signedData, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(data.storage_path, 60);

    if (signError || !signedData?.signedUrl) {
      console.error("Signed URL error:", signError);
      return res.status(500).json({ error: "Could not generate download link" });
    }

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

/**
 * GET /api/info/:token
 * Returns basic file info so Person 2 can see filename + expiry before entering password
 */
app.get("/api/info/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const { data, error } = await supabase
      .from("files")
      .select("filename, expires_at, created_at")
      .eq("token", token)
      .single();

    if (error || !data)
      return res.status(404).json({ error: "File not found or link expired" });

    if (new Date() > new Date(data.expires_at))
      return res.status(410).json({ error: "This link has expired" });

    return res.json({
      filename: data.filename,
      expiresAt: data.expires_at,
    });
  } catch (err) {
    console.error("Info route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Cron: Auto-delete expired files every 15 minutes ────────────────────────
cron.schedule("*/15 * * * *", async () => {
  console.log("Cron: checking for expired files...");
  try {
    const { data: expiredFiles, error } = await supabase
      .from("files")
      .select("id, storage_path")
      .lt("expires_at", new Date().toISOString());

    if (error) {
      console.error("Cron DB fetch error:", error);
      return;
    }

    if (!expiredFiles || expiredFiles.length === 0) {
      console.log("   No expired files found.");
      return;
    }

    console.log(`   Found ${expiredFiles.length} expired file(s). Deleting...`);

    const paths = expiredFiles.map((f) => f.storage_path);
    await supabase.storage.from(BUCKET).remove(paths);

    const ids = expiredFiles.map((f) => f.id);
    const { error: dbError } = await supabase
      .from("files")
      .delete()
      .in("id", ids);

    if (dbError) console.error("Cron DB delete error:", dbError);
    else console.log(`   Deleted ${expiredFiles.length} expired file(s).`);
  } catch (err) {
    console.error("Cron job error:", err);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
