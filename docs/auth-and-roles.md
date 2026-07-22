# ROS logins & roles

> **Status: auth is currently OFF (review mode).** The site is public with no login so it can be
> shared for review. Everyone is treated as an owner-level guest. All the login code below is built
> and dormant — turn it on at the final stage with **one flag**:
>
> - cloud: set env `ROS_AUTH=1`, or
> - local: add `"authEnabled": true` to `secrets.json`
>
> then restart. On first start with auth on, the owner login is seeded (see "First login").

Added so ROS can safely go on a public URL. Every page and API requires a session **when auth is on**.

## Roles

| Role | Can do |
|---|---|
| **staff** | Everything operational: view dashboards, inventory, receiving scans, fulfillment, customers. |
| **manager** | All of staff **plus** send marketing, publish to the website, post/void invoices. |
| **owner** | Everything **plus** API keys/integration settings and managing team logins. |

The server enforces these — hiding a button in the UI is not the gate. A staff member calling a
manager-only API directly gets `403`.

## First login

On first start ROS creates one **owner**:

- If `ROS_OWNER_PASSWORD` is set (used in the cloud), that becomes the owner password.
- Otherwise a random password is generated and **printed to the console once**. Look for:
  ```
  *** ROS first-run owner login (shown once) ***
  Username: owner
  Password: ab12cd34ef
  ```
Log in, then add the rest of the team and change the owner password under **Settings → Team**.

Username is `owner`. Passwords are stored only as a salted scrypt hash — never in plain text, never
sent to the browser.

## Adding managers and staff (owner only)

Team management endpoints (`/api/users`): create a login with a username, name, role and password;
reset a password; remove a login. The last owner cannot be deleted.

## How it works (for maintenance)

- Passwords: Node `crypto.scryptSync` with a per-user random salt.
- Sessions: a signed cookie (`ros_session`), HMAC-SHA256 over `{userId, role, expiry}` using a
  server secret in `secrets.json` (`authSecret`, auto-generated). **Stateless** — no session store —
  so it survives server restarts and needs no sticky sessions in the cloud. Sessions last 14 days.
- The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when served over HTTPS.
- Public paths (no login): `/login.html`, the `/api/auth/*` endpoints, `/api/health`, and PWA assets.

## Testing locally

1. Restart the server, watch the console for the one-time owner password.
2. Open `http://localhost:4000` → you're redirected to the login page.
3. Sign in as `owner`. The old UI (`index.html`) still loads by default; the new UI is at
   `/preview.html` and shows your name + a **Sign out** button in the sidebar.
4. Create a staff login under Team, sign out, sign back in as that user — confirm the limited view
   and that owner-only actions are blocked.

## Note

Making the new PB UI the default (instead of `index.html`) happens in Phase 2, after its missing
panels are ported, so no feature is lost in the switch.
