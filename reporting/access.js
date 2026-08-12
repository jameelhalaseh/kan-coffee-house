// Access control (§7).
//
// Two separate grants, and the API enforces BOTH — a hidden button is not access control.
// §8.10 is a test that a `reports`-only user gets a 403 from the expense-create endpoint,
// because the failure mode being guarded against is not a curious cashier clicking around,
// it is someone with a session and curl.
//
//   reports        → may VIEW any financial report
//   reports:edit   → may CREATE or DELETE expenses, expense types, partners and draws
//
// Admins bypass both.
const VIEW_GRANT = 'reports';
const EDIT_GRANT = 'reports:edit';

// `allowed_views` is what this codebase's session middleware puts on req.user
// (server/auth.js); `views`/`grants` are accepted so the module stays mountable in a host
// app that names the field differently, and so the acceptance suite can build a user without
// importing the host's auth.
const grants = (user) => (user && (user.allowed_views || user.views || user.grants || [])) || [];
const isAdmin = (user) => !!(user && (user.admin || user.role === 'admin'));

const canView = (user) => isAdmin(user) || grants(user).includes(VIEW_GRANT);
// Note the deliberate asymmetry: reports:edit is NOT implied by reports, and does not imply
// it either — it is checked on its own, so a grant list cannot accidentally widen by
// containing the string 'reports'.
const canEdit = (user) => isAdmin(user) || grants(user).includes(EDIT_GRANT);

const requireSession = (req, res, next) =>
  (req.user ? next() : res.status(401).json({ error: 'session' }));

const requireReportsView = (req, res, next) =>
  (canView(req.user) ? next() : res.status(403).json({ error: 'forbidden' }));

const requireReportsEdit = (req, res, next) =>
  (canEdit(req.user) ? next() : res.status(403).json({ error: 'forbidden' }));

// Entrance TAKINGS are deliberately visible only inside Reports, never in the operational
// entrance screen, so floor staff cannot see the day's cash. The operational payload is
// stripped here rather than at each call site — a new screen that forgets to strip it is
// exactly how the number leaks.
const operationalTicket = (t) => {
  const { fee, pay, ...rest } = t || {};
  return rest;
};

module.exports = {
  VIEW_GRANT, EDIT_GRANT, canView, canEdit,
  requireSession, requireReportsView, requireReportsEdit, operationalTicket, isAdmin,
};
