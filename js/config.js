// Runtime configuration. The deploy workflow rewrites `apiUrl` with the address
// of the Cloudflare Worker when one is deployed. Leave it empty to run the app
// with the built-in understanding and in-app reminders only.
window.CADENCE_CONFIG = {
  apiUrl: '',
};
