/* ═══════════════════════════════════════════════════════════
   RSMS BRAND — owner / company branding knobs
   -----------------------------------------------------------
   One place to point RSMS at the owner's photo. Used by:
     • index.html        — landing logo tile + AI assistant head
     • rsms-control.html — owner avatar in the control status bar

   ownerAvatar   : URL (or local path) of the owner photo.
                   Preferred: commit the photo to assets/owner-avatar.jpg
                   and set this to 'assets/owner-avatar.jpg' so the site
                   has no external dependency.
   ownerName     : used for alt text / tooltips.
   ownerInitials : shown until (or instead of) the photo.

   Runtime override: set window.RSMS_OWNER_AVATAR before these pages
   render and it wins over the value below.
   ═══════════════════════════════════════════════════════════ */

window.RSMS_BRAND = {
  // Hosted copy of the owner photo. NOTE: this Kommodo link expires
  // 2026-10-11 — replace with 'assets/owner-avatar.jpg' as soon as the
  // file is committed to the repo.
  ownerAvatar: 'https://plain-weur-prod-public.komododecks.com/202609/11/3lkmvEjKiTimMyvf0Dad/image.jpg',
  ownerName: 'Rehoteq Technologies',
  ownerInitials: 'BT'
};
