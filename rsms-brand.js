/* ═══════════════════════════════════════════════════════════
   RSMS BRAND — the assistant's face and name
   -----------------------------------------------------------
   Configures the AI assistant on the landing page ("Toye").

   assistantName : the name visitors see in the panel head, the
                   "Hi, I'm Toye" pill and screen-reader labels.
   ownerAvatar   : the photo used as the bot's face. It appears in
                   exactly two places, both of them the bot:
                     • the floating button (a face gets clicks)
                     • the panel head
                   The RSMS "R" logo tile and every other RSMS mark
                   are left exactly as they are.
                   Preferred: commit the photo to assets/owner-avatar.jpg
                   and set this to 'assets/owner-avatar.jpg' so the site
                   has no external dependency.
   ownerName     : alt text for the photo.

   Until a photo is configured nothing is requested, so there is no
   broken-image request — the robot icon and the gold "R" stay.

   Runtime override: set window.RSMS_OWNER_AVATAR before the page
   renders and it wins over the value below.
   ═══════════════════════════════════════════════════════════ */

window.RSMS_BRAND = {
  assistantName: 'Toye',

  // Hosted copy of the owner photo. NOTE: this Kommodo link expires
  // 2026-10-11 — replace with 'assets/owner-avatar.jpg' as soon as the
  // photo is committed to the repo.
  ownerAvatar: 'https://plain-weur-prod-public.komododecks.com/202609/11/3lkmvEjKiTimMyvf0Dad/image.jpg',
  ownerName: 'Rehoteq Technologies'
};
