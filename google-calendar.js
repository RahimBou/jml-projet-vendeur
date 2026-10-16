// Google Calendar integration intentionally disabled to prevent external API calls.
// Appointment availability continues to use local JML/PostgreSQL bookings only.
// Re-enable only after explicit approval and tests in a non-production environment.

const SCOPES = [];

async function registerGoogleCalendarRoutes(_app, _options = {}) {
  console.info("JML Google Calendar integration disabled; no routes registered.");
}

async function getGoogleCalendarBusy(_pool, _start, _end) {
  return [];
}

async function createGoogleCalendarEvent(_pool, _event) {
  return null;
}

async function deleteGoogleCalendarEvent(_pool, _eventId) {
  return false;
}

module.exports = {
  registerGoogleCalendarRoutes,
  getGoogleCalendarBusy,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  SCOPES
};
