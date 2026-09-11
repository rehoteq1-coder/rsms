/* ═══════════════════════════════════════════════════════════
   RSMS BRAND — AI assistant face
   -----------------------------------------------------------
   Configures the photo shown in the head of the AI assistant
   widget on the landing page. This is the ONLY place the photo
   is used — the RSMS "R" logo tile and every other RSMS mark
   are left exactly as they are.

   ownerAvatar : URL (or local path) of the photo.
                 Preferred: commit the photo to assets/owner-avatar.jpg
                 and set this to 'assets/owner-avatar.jpg' so the site
                 has no external dependency.
   ownerName   : alt text / tooltip for the photo.

   Until a photo is configured nothing is requested, so there is
   no broken-image request — the gold "R" stays.

   Runtime override: set window.RSMS_OWNER_AVATAR before the page
   renders and it wins over the value below.
   ═══════════════════════════════════════════════════════════ */

window.RSMS_BRAND = {
  // Hosted copy of the owner photo. NOTE: this Kommodo link expires
  // 2026-10-11 — replace with 'assets/owner-avatar.jpg' as soon as the
  // photo is committed to the repo.
  ownerAvatar: 'https://plain-weur-prod-public.komododecks.com/202609/11/3lkmvEjKiTimMyvf0Dad/image.jpg',
  ownerName: 'Rehoteq Technologies'
};
