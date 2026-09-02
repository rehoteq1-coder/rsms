# RSMS Offline — School Installation & Operation Manual

**For:** the school's ICT administrator and staff (after training)
**Version:** 0.3.0 (Phase C) · **Companion docs:** `pilot-playbook.md` (platform side)

---

## 1. What this is (2-minute read)

RSMS Offline is a **local copy of your school's RSMS that lives on one
always-on PC in your building**. Staff use it from any phone or laptop on
the school Wi-Fi, exactly like the normal RSMS portal.

- **It works with no internet at all.** Fees, students, cash receipts —
  everything is recorded on the PC and saved safely in a local database.
- **When the internet is back, it syncs by itself** (every ~60 seconds)
  with the cloud RSMS. You do nothing.
- **Cash and bank-transfer receipts work offline** and show
  *"Sync pending"* until the cloud confirms them. Card payments stay
  cloud-only (they need the internet, as before).
- **Money disagreements are never decided by the computer.** If the
  school PC and the cloud disagree about money, the record is parked in
  the **Bursar Conflict Review** screen and the bursar chooses which side
  wins. Nothing is ever silently overwritten.

One PC = one school. The appliance is bound to your school's code and
cannot be re-pointed at another school.

---

## 2. Equipment the school needs

### Must have
| Item | Minimum spec | Notes |
| --- | --- | --- |
| Dedicated desktop PC (always on) | Windows 10/11 64-bit, 4 GB RAM, i3-class CPU, 120 GB disk (SSD preferred) | Absolute minimum: 2 GB RAM / 50 GB disk. A laptop is acceptable only if it stays plugged in, running, and never sleeps. |
| Reliable power | Mains + **UPS (power backup)** strongly recommended | Set the PC's BIOS to "power on after power failure" so it returns automatically after a blackout. The database is safe during power cuts, but the PC must come back on its own. |
| Network | Ethernet cable to the school LAN (Wi-Fi acceptable, cable preferred) | The PC does **not** need internet to serve staff — internet is only used for background sync. |
| Router with DHCP reservation | Any modern router | The ICT person must reserve this PC's IP so it never changes (wizard tells them how). |
| Locked room or locked cabinet | — | The PC holds a term of school data; treat it like a cash box. Use a locked, least-privilege Windows account for day-to-day access. |
| Staff devices | Any phone/laptop with a browser, on the school Wi-Fi | Staff scan the QR code to open the portal. |

### Nice to have
| Item | Why |
| --- | --- |
| Printer | To print the staff QR code for the staff room. |
| USB stick or external disk (or NAS share) | Second backup destination, separate from the system disk. |
| Second monitor | Optional, for the bursar's station. |

### NOT needed
- No server, no database licence, no Windows Server.
- No internet line just for this — the existing school connection is
  enough (sync uses very little bandwidth).
- No hardware beyond the PC.

---

## 3. Installation day (ICT administrator, ~30 minutes)

### Before starting
- [ ] PC is in its locked room/cabinet, plugged in, on the LAN.
- [ ] The RSMS installer file (`rsms-offline-setup-<version>.exe`) is on
      the PC (USB from the platform team).
- [ ] The platform superadmin has **registered your school offline** and
      given you: the **school code**, the **one-time server token**
      (`rsms-offline-…`), and the **cloud base URL**. Write them down —
      the token is shown only once.

### Step 1 — Run the installer
1. Double-click `rsms-offline-setup-<version>.exe`.
2. If Windows shows a blue SmartScreen screen: **More info → Run anyway**
   (the installer is signed by the platform; the warning is normal until
   code-signing is added).
3. Accept the UAC prompt. Click **Next** through the wizard (the install
   folder `C:\ProgramData\RSMS-Offline` is correct — leave it).
4. The installer also creates the **RSMSOffline Windows service**
   (auto-start after every reboot, self-restarting if it ever stops).
   When it finishes, close the wizard.

### Step 2 — First-run wizard
Open on the PC itself (or any LAN device):

    http://<PC-IP>:8300/staff-login.html

1. **Create the first staff account** (bootstrap): username, name, role
   `admin`, and a strong PIN (6+ digits, written down and stored safely —
   PINs cannot be recovered, only reset via the platform).
2. Log in, then open the wizard:

       http://<PC-IP>:8300/wizard.html

3. **Bind the school**: enter the school code, school name, the **server
   token** and the **cloud base URL**. A success message ending in
   *"Cloud sync active"* means the binding was verified against the
   cloud. (If you don't have a token yet, enter the code alone — the
   appliance works fully offline and sync activates when a token is
   supplied later.)
4. **Staff access**: screenshot or print the **QR code** for the staff
   room. Note the PC's LAN IP.
5. **DHCP reservation (important):** follow the wizard's instruction —
   at the router, reserve this PC's current IP for its MAC address so the
   IP never changes. Without this, every staff device loses the portal
   after the next IP renewal.
6. **Backups:** set the backup destination (default: the system disk; a
   USB stick/external disk/NAS is better) and click **Run first backup
   now**. Wait for the green "verified" line.

### Step 3 — Verify
Open `http://<PC-IP>:8300/health` and confirm:
- **Bound school** shows your school + "(cloud validated)".
- **Outbox** counts (pending may be a few — they clear on the next sync).
- **Backups** shows the backup you just ran.
- **Disk free**, **Service** rows present.

### Step 4 — Train staff (30 minutes, once)
- How to open the portal from a phone (scan QR / type the IP).
- How to log in (username + PIN) and which screens each role sees.
- Cash/bank receipt entry and what *"Sync pending"* means.
- The bursar's two watch screens: **/health** and **/conflicts.html**.

---

## 4. Daily operation

### Staff
- Open the portal from the QR code (school Wi-Fi only — the portal is
  **not** on the public internet).
- Log in with username + PIN. Record students, fees, cash/bank receipts
  as normal. Card payments require internet (cloud-only, as before).
- Receipts taken while offline show **Sync pending** — they are safe on
  the PC and will confirm themselves once the internet returns.

### Bursar (twice a day, 2 minutes each)
1. **Health page** (`http://<PC-IP>:8300/health`):
   - *Outbox pending* should be near 0 while internet is up.
   - *Last cloud sync* should be recent (within the last few minutes).
   - *Backups* should show yesterday's nightly backup (runs 03:15, keeps
     7 days).
2. **Conflict Review** (`http://<PC-IP>:8300/conflicts.html`):
   - If any open conflict appears (money rows only — never auto-merged),
     read the local vs cloud values, then choose **Local wins** (re-push
     this PC's record) or **Cloud wins** (adopt the cloud record).
   - Resolve financial conflicts **before** further financial activity.

### ICT administrator (weekly, 5 minutes)
- Health page: service boot count, disk free (act before it goes red),
  backups current.
- Confirm the PC came back on after any power cut (BIOS auto-power-on).

---

## 5. Backups

- **Nightly automatic** verified backup at 03:15; the last **7** are
  kept, older ones pruned automatically.
- Location: the destination set in the wizard (default
  `C:\ProgramData\RSMS-Offline\offline\data\backups`; a separate
  disk/USB/NAS is strongly preferred).
- **Before risky work** (Windows update, PC move, suspected corruption),
  run an extra backup from the admin session
  (`POST /api/admin/backup`, or ask the platform).
- **Restore:** admin-only, requires confirmation (school code + exact
  backup time). It makes an emergency copy of the current state first,
  pauses writes for a few seconds, and restores. After any restore,
  review the outbox and conflicts before continuing.
- **If you suspect data trouble:** stop, take a fresh backup, and
  download the diagnostics bundle (below) — do not delete anything.

---

## 6. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Phones/laptops can't open the portal | PC's IP changed | Re-open the wizard, note the new IP, re-print the QR, and finally fix it properly with the **DHCP reservation**. |
| Everything works but *Outbox pending* stays high | Internet is down (or the PC has no route to it) | Normal during outages — data is safe. When the internet returns it clears within a minute or two. If it stays high with internet up, call the platform. |
| Open conflict on /conflicts.html | Local and cloud money records differ | Bursar resolves it (Local wins / Cloud wins). Never ignore — resolve finance conflicts first. |
| Health says the service didn't boot / PC was off | Power cut, PC didn't auto-start | Start the PC; the service starts itself. Check BIOS "power on after power failure". |
| Disk free turning red | Disk filling up | Move the backup destination to a bigger/external disk, free space, then run a fresh backup. |
| Portal shows old data on one device | Stale browser cache | Close and reopen the portal / clear that browser's cache for the site. |
| Forgot a staff PIN | — | PINs are hashed and **cannot be recovered**. Contact the platform to reset the account (data is untouched). |
| Anything else | — | Download the diagnostics bundle and call the platform (below). |

---

## 7. Do's and Don'ts

**Do**
- Keep the PC running (it *is* the school's system of record when
  offline).
- Keep the room/cabinet locked and the Windows account locked.
- Write down the admin username/PIN and store them safely (with the
  school's other credentials — not on a sticky note on the PC).
- Take an extra backup before Windows updates or any PC move.
- Do the weekly health check (5 minutes).

**Don't**
- Don't install the software on a PC that gets shut down, moved, or
  used as a general machine.
- Don't let anyone "rebind" the PC to a different school — one install,
  one school (the cloud refuses a second installation for one school).
- Don't delete or "clean up" `C:\ProgramData\RSMS-Offline\offline\data`
  — that folder *is* the school's database.
- Don't change the PC's IP manually (use the DHCP reservation).
- Don't try to fix a money conflict by re-entering the receipt — use the
  Conflict Review screen.
- Don't share the admin PIN; give each staff member their own account.

---

## 8. Getting support (platform)

1. On an **admin** session, open and download:

       http://<PC-IP>:8300/api/admin/diag.download

   (a small JSON file — it contains system state, sync counts and recent
   activity; it contains **no PINs, no server token, no keys**.)
2. Note: the school code, the date/time the problem started, what you
   were doing, and a screenshot of the screen involved.
3. Send the file + notes to the platform support channel:
   **_[platform contact name / phone / email — fill in before printing]_**

The platform can see, from the diagnostics: whether sync is paused and
why, backup freshness, schema state, recent errors and the audit trail.

---

*This manual covers the offline appliance only. Card payments, parent
portals and cloud-side settings remain on the cloud RSMS as before.*
