# The Railway template

How the **Deploy on Railway** button ([railway.com/deploy/OfFLtE](https://railway.com/deploy/OfFLtE)) is built. You only need this if you maintain the template; to *use* it, click the button in the README.

Create it at **railway.com → Templates → New template** (or "Create template" from a working project). The repo must be public so other people's deploys can pull from it.

## Services

### Postgres
Add the Postgres database. Nothing to set.

### livekit
| Setting | Value |
|---|---|
| Source | this GitHub repo |
| Root directory | `/deploy/livekit` |
| Public domain | yes, port **7880** |
| TCP proxy | port **7881** |
| Healthcheck | `/` |

Variables:
```
PORT=7880
LIVEKIT_API_KEY=${{secret(16)}}
LIVEKIT_API_SECRET=${{secret(48)}}
```

### app
| Setting | Value |
|---|---|
| Source | this GitHub repo |
| Root directory | `/` |
| Public domain | yes, port **8080** |
| Healthcheck | `/health` |

Variables:
```
PORT=8080
NODE_ENV=production
PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
SESSION_SECRET=${{secret(64)}}
DATABASE_URL=${{Postgres.DATABASE_URL}}
LIVEKIT_URL=wss://${{livekit.RAILWAY_PUBLIC_DOMAIN}}
LIVEKIT_API_KEY=${{livekit.LIVEKIT_API_KEY}}
LIVEKIT_API_SECRET=${{livekit.LIVEKIT_API_SECRET}}
GOOGLE_LOGIN_CLIENT_ID=          # asked when deploying
GOOGLE_LOGIN_CLIENT_SECRET=      # asked when deploying
ALLOWED_EMAIL_DOMAINS=           # asked when deploying, e.g. yourcompany.com
ADMIN_EMAILS=                    # asked when deploying, e.g. you@yourcompany.com
```
Give the four "asked" variables a short description in the template editor. Railway shows those descriptions on the deploy screen.

## Left out on purpose
The **transcriber** isn't in the template. It's optional, and building it bakes a Whisper model into the image (a few minutes and ~1 GB). People add it afterwards (README → "Optional: transcription").
