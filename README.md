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

Each scholarship in `data/scholarships.js` belongs to an office (`LSO`, `POLCA`, `ALUMNI`), and each application stores that office. Which applications an admin sees depends on the `office` in their Clerk public metadata:

| Clerk public metadata | Sees |
|---|---|
| `{ "role": "admin" }` (no office) | The LSO: its own applications (SFA Grant, Entrance) plus whatever POLCA and Alumni have sent over |
| `{ "role": "admin", "office": "POLCA" }` | Only POLCA applications |
| `{ "role": "admin", "office": "ALUMNI" }` | Only Alumni Association applications |

POLCA and Alumni admins review their own applicants, then click **Send to LSO** (`POST /api/applications/forward`). That sends every application the office hasn't sent yet, whatever its status. Applications submitted later stay with the office until its next send. The office's decision stands, but the LSO can override it; the dashboard labels overrides.

After deploying, tag existing applications with their office once:

```bash
node backfillApplicationOffice.js --dry-run
node backfillApplicationOffice.js
```

## Notes

- Application documents are stored in MongoDB GridFS.
- The backend includes origin checks for mutating requests via `FRONTEND_ORIGINS`.
- For full system flow, see [architecture-overview.md](D:/AniSkolar/docs/architecture-overview.md).