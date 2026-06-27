# VideoStream
> Infrastructure: [videostream-infra](https://github.com/Mohammed-Hassan-123/videostream-infra)

A self-hosted video streaming platform built with Node.js. Users can browse and stream videos through a clean web interface; admins can upload, rename, delete videos, and manage thumbnails through a built-in panel.

## Features

- User authentication — signup, login, session-based auth
- Video library — browsable grid of videos with thumbnails
- Video streaming — HTTP range request support for seek/resume
- Admin panel — upload videos, rename, delete, manage thumbnails

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express |
| Database | PostgreSQL |
| Object storage | MinIO |
| Sessions | connect-pg-simple (stored in PostgreSQL) |
| Reverse proxy | Nginx |
| Container | Docker |

## Architecture

```
Browser → Nginx (:80) → videostream app (:3000)
                                 ├── PostgreSQL (192.168.x.26:5432)  — users, sessions, video metadata
                                 └── MinIO      (192.168.x.25:9000)  — video files and thumbnails
```

The app and Nginx run as Docker containers on the same `internal` bridge network. PostgreSQL and MinIO are external services on the local network (see [videostream-infra](https://github.com/Mohammed-Hassan-123/videostream-infra)).

## Environment Variables

Copy `.env.example` to `.env` and fill in all values.

| Variable | Description |
|---|---|
| `NODE_ENV` | Runtime environment (`production`) |
| `TZ` | Timezone for logs (`Asia/Dhaka`) |
| `MINIO_ENDPOINT` | MinIO host IP or hostname |
| `MINIO_PORT` | MinIO port (default `9000`) |
| `MINIO_ACCESS_KEY` | MinIO access key |
| `MINIO_SECRET_KEY` | MinIO secret key |
| `MINIO_BUCKET` | MinIO bucket name for videos and thumbnails |
| `PG_HOST` | PostgreSQL host IP or hostname |
| `PG_PORT` | PostgreSQL port (default `5432`) |
| `PG_DATABASE` | Database name |
| `PG_USER` | Database user |
| `PG_PASSWORD` | Database password |

## Running Locally

```bash
cp .env.example .env
# fill in .env

docker compose up -d
```

The app is served at `http://localhost` via Nginx. Logs are mounted to `./logs`.

## Infrastructure

Deployment configs (PostgreSQL, MinIO, network setup) live in the companion repo:
[https://github.com/Mohammed-Hassan-123/videostream-infra](https://github.com/Mohammed-Hassan-123/videostream-infra)
