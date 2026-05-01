const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function initDB() {
  const { error } = await supabase.from("files").select("id").limit(1);
  if (error && error.code === "42P01") {
    console.error("\n❌  Table 'files' does not exist. Run this SQL:\n");
    console.error(`
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
    `);
    process.exit(1);
  }
  console.log("✅  Supabase DB connection OK");
}

module.exports = { supabase, initDB };