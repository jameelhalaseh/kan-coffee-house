-- Security audit, 12 Aug 2026 (F-05): session tokens and password-reset codes are stored as
-- SHA-256, not as the secret itself.
--
-- Before this, app_users.session_token held the live bearer token verbatim and reset_code held
-- the 6-digit code. Anyone able to read the table — a backup file, a support dump, a read-only
-- bug — could impersonate every logged-in user immediately, or complete a password reset
-- without access to the mailbox. The application now hashes on the way in and looks up by hash
-- (server/auth.js).
--
-- EVERY ACTIVE SESSION IS INVALIDATED HERE, deliberately. The stored values are plaintext
-- tokens that the new code can never match, so leaving them would only produce sessions that
-- fail confusingly on the next request. Clearing them logs everyone out once, cleanly, and
-- also destroys the plaintext this migration exists to stop storing.
--
-- Outstanding reset codes are cleared for the same reason: a code issued before the deploy
-- cannot be confirmed after it. Anyone mid-reset requests a new one.

update app_users
   set session_token = null,
       token_exp     = null
 where session_token is not null;

update app_users
   set reset_code = null,
       reset_exp  = null
 where reset_code is not null;

-- The columns now hold 64-character lowercase hex digests. Left as text: a check constraint
-- would have to allow NULL and would buy nothing the application does not already guarantee.
comment on column app_users.session_token is
  'SHA-256 of the bearer token (hex). Never the token itself — see server/auth.js hashSecret().';
comment on column app_users.reset_code is
  'SHA-256 of the reset code (hex). Never the code itself — see server/auth.js hashSecret().';
