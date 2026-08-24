/* Copy only the sync block into rsms-config.js when preparing a pilot.
   This foundation is intentionally local-only even when a transport name is selected. */
window.RSMS_CONFIG = window.RSMS_CONFIG || {};
window.RSMS_CONFIG.sync = {
  enabled: false,
  transport: 'disabled' // Allowed interface names: disabled, firebaseGateway, lanHub
};
