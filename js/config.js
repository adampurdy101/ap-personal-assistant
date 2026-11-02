// ============================================================
//  CONFIG  ·  safe-to-publish settings
//  The Supabase URL and publishable key are meant to live in front-end
//  code. They can only touch data through Row Level Security + login.
//  NEVER put a service-role key or any secret here.
// ============================================================
export const CONFIG = {
  SUPABASE_URL: "https://fzsfizqkolkxkorgvtcl.supabase.co",
  SUPABASE_KEY: "sb_publishable_qyUnnnqgGGQ7yCV9qdA5iQ_JLv5A-nw",
  // the ONE account this app belongs to; any other login is signed back out
  OWNER_ID: "30cbcbfa-7261-47de-8c91-3d97557fc5f9",
  TZ: "America/Los_Angeles",
  APP_NAME: "AP Personal Assistant",
};
