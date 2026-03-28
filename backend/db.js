const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Creates the 'files' table in Supabase if it doesn't exist.
 * Run this once on server start.
 *
 * Table schema:
 *   id          uuid primary key
 *   token       text unique         -- the URL token Person 2 uses
 *   filename    text                -- original file name
 *   storage_path text               -- path inside Supabase bucket
 *   password_hash text              -- bcrypt hash of the password
 *   expires_at  timestamptz         -- when to auto-delete
 *   created_at  timestamptz
 */
async function initDB() {
  // We use raw SQL via Supabase's rpc — but since we can't run DDL directly
  // from the JS client without the pg extension, we just check the table exists
  // by doing a dummy select. If it fails, we print a helpful error.
  const { error } = await supabase.from("files").select("id").limit(1);
  if (error && error.code === "42P01") {
    console.error(
      "\n❌  Table 'files' does not exist in your Supabase project."
    );
    console.error("   Please run this SQL in your Supabase SQL editor:\n");
    console.error(`
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text UNIQUE NOT NULL,
  filename      text NOT NULL,
  storage_path  text NOT NULL,
  password_hash text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz DEFAULT now()
);
    `);
    process.exit(1);
  }
  console.log("✅  Supabase DB connection OK");
}

module.exports = { supabase, initDB };
