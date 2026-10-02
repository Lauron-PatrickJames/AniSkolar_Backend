# AniSkolar Backend

Backend API for AniSkolar (Scholarship Management Portal), built with Express + MongoDB (Mongoose).

## Current Auth Model

AniSkolar now uses **Clerk** for authentication:

- Frontend signs users in via Clerk.
- Backend validates Clerk sessions using `@clerk/express`.
- Student profile data is stored in MongoDB and linked by `clerkId`.

## Active API Routes

Mounted in [server.js](D:/AniSkolar/AniSkolar_Backend/server.js):

- `GET /` (health check)
- `/api/students`
- `/api/applications`
- `/api/application-drafts` (saved-for-later grant application drafts)
- `/api/announcements` (managing announcements is AdSO-only; `GET /api/announcements/feed` is the public published feed)
- `/api/scholarships` (scholarship status and details; reading is public, editing via `PATCH /api/scholarships/:id` is AdSO-only; `GET /api/scholarships/admin` adds application counts)

## Requirements

- Node.js (LTS recommended)
- npm
- MongoDB Atlas (or local MongoDB)
- Clerk project (publishable + secret keys)

## Setup

```bash
cd AniSkolar_Backend
npm install
```

Create `.env` from `.env.example`, then set:

- `MONGODB_URI`
- `PORT` (optional, default `5000`)
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `FRONTEND_ORIGINS` (comma-separated, e.g. `http://localhost:3000`)

## Run

```bash
node server.js
```

Backend default URL:

```text
http://localhost:5000
```

## Project Structure

```text
AniSkolar_Backend/
├── data/
├── middleware/
├── models/
├── routes/
├── utils/
├── server.js
└── test-connection.js
```

## Scholarship Offices

Each scholarship in `data/scholarships.js` belongs to an office (`LSO` = AdSO, `POLCA`, `ALUMNI`), and each application stores that office. Every admin account needs an `office` in its Clerk public metadata. An admin without one (or with any other value) is refused.

| Clerk public metadata | Sees |
|---|---|
| `{ "role": "admin", "office": "ADSO" }` | The Admissions and Scholarship Office (AdSO): its own applications (SFA Grant, Entrance) plus whatever POLCA and Alumni have sent over |
| `{ "role": "admin", "office": "POLCA" }` | Only POLCA applications |
| `{ "role": "admin", "office": "ALUMNI" }` | Only Alumni Association applications |

Applications store the AdSO as the office code `LSO` (its code before the rename), so no data migration is needed.

When a POLCA or Alumni admin **approves** an application, it's sent to the AdSO automatically — there's no manual send, so approved students reach the AdSO with no delay. Applications the office hasn't approved (under evaluation, needs revision, rejected) stay with the office. The office's decision stands, but the AdSO can override it; the dashboard labels overrides, and once the AdSO overrides, the office can no longer change that application's status or note.

After deploying, tag existing applications with their office once:

```bash
node backfillApplicationOffice.js --dry-run
node backfillApplicationOffice.js
```

## Facebook Page integration (announcements)

AniSkolar is the source of truth for announcements; it pushes them to the AdSO Facebook Page and never reads posts back.

- **Create:** an announcement published with **Also post to Facebook** on (the default) is posted to the Page. A text-only post uses `POST /{page-id}/feed`. A post with an image uses `POST /{page-id}/photos`, one image per announcement.
- **Edit:** a text edit updates the post (`POST /{post-id}`). Changing the image deletes the post and creates a new one, because Facebook can't swap a photo post's image. Unpublishing, or turning the toggle off, deletes the post.
- **Delete:** deleting an announcement deletes its post (`DELETE /{post-id}`). If Facebook refuses, the announcement is still deleted and the admin is told to remove the post on the Page.
- **Failures:** the announcement is always saved to MongoDB first. If Facebook fails, the record is kept with `fbStatus: 'failed'` and `fbError`. The admin list shows a **Retry** button, which calls `POST /api/admin/announcements/:id/facebook/retry` (also available at `/api/announcements/:id/facebook/retry`). An expired or invalid token (Graph error 190) produces a message saying the Page token needs renewing.
- **Code:** every Graph API call goes through `services/facebook.js` (`publishPost`, `updatePost`, `deletePost`). The routes are in `routes/announcements.js` and are AdSO-only.

### SETUP

1. **Create the Meta app.**
   - At https://developers.facebook.com/apps, click **Create app**.
   - Pick the use case for managing a Page / business (the "Business" app type).
   - Note the **App ID** and **App Secret** under *App settings → Basic*.
2. **Connect the AdSO Page.** The person generating the token must:
   - have a role on the app (admin, developer or tester), and
   - manage the AdSO Facebook Page with permission to create content.
3. **Get a short-lived user token.**
   - Open the Graph API Explorer (https://developers.facebook.com/tools/explorer).
   - Select the app, choose **Get User Access Token**, and grant `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`.
   - When asked which Pages the app can use, select the AdSO Page.
4. **Exchange it for a long-lived user token:**
   ```
   GET https://graph.facebook.com/{FB_GRAPH_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={SHORT_LIVED_USER_TOKEN}
   ```
5. **Get the long-lived Page token and Page ID:**
   ```
   GET https://graph.facebook.com/{FB_GRAPH_VERSION}/me/accounts?access_token={LONG_LIVED_USER_TOKEN}
   ```
   In the entry for the AdSO Page, `access_token` is the Page access token and `id` is the Page ID.
6. **Check the token** in the Access Token Debugger (https://developers.facebook.com/tools/debug/accesstoken/). It should show the Page, the `pages_manage_posts` scope, and **Expires: Never**.
7. **Set the server environment variables** in `.env` or your host's settings. Never put them in the frontend:
   ```
   FB_PAGE_ID=1234567890
   FB_PAGE_ACCESS_TOKEN=EAAG...
   FB_GRAPH_VERSION=v23.0   # use the current version from Meta's Graph API changelog
   ```
   Restart the server afterwards.

**Development mode vs. App Review.**
- While the app is in *Development* mode, posting works only for people with a role on the app (admin, developer or tester) who also manage the Page. That's enough for the AdSO team if every poster is added to the app.
- Before anyone else can use it, the app needs **App Review** for `pages_manage_posts` (and `pages_read_engagement` / `pages_show_list`), usually with Business Verification, and must be switched to *Live*.

**When the token stops working:**
- The Page token becomes invalid if the person who generated it changes their Facebook password, loses their Page role, or removes the app.
- The admin dashboard will then report that the Page token needs renewing.
- To fix it, repeat steps 3–7, then click **Retry** on any failed announcements.

## Notes

- Application documents are stored in MongoDB GridFS.
- The backend includes origin checks for mutating requests via `FRONTEND_ORIGINS`.
- For full system flow, see [architecture-overview.md](D:/AniSkolar/docs/architecture-overview.md).