# Rocket Racer

A 2D rocket racing game in crisp, high-definition 8-bit style. Race five AI rivals around
planets and through asteroid fields, threading giant donut checkpoints, grabbing power-ups
and firing weapons along the way.

It runs in any modern browser, plays well on phones, and ships with a small Google Cloud
backend: one Cloud Run service serves the game and a global leaderboard stored in Firestore.

## The game

- **Three courses**: Lunar Loop (easy oval), Donut Drift (figure-eight through an asteroid
  belt) and Gravity Gauntlet (planet slalom, orbiting rocks, long asteroid wall).
- **Donut checkpoints**: fly through every donut in order. The next one glows and an arrow
  at the screen edge points to it. The checkered donut is start/finish. Three laps.
- **Planets** are solid and pull on your rocket. **Asteroids** drift, bounce and can be shot.
- **Power-ups** (green capsules, used instantly): Nitro, Shield, Repair.
- **Do-over** (rare violet capsule, kept until you use it): rewinds your ship 3 seconds. You
  fly the way back as a ghost along the path you just took, then carry on from there with the
  hull, lap and gate progress you had then, and 2 seconds of protection. It also undoes a
  wreck. The race clock and your rivals keep going, so it costs time. While you hold one, a
  faint ghost marks where it would put you. Rivals can't use it.
- **Weapons** (red crates, one slot): Blaster, homing Missile, Mine, EMP shockwave.
- **Rivals** in three skill levels: Rookie, Pilot, Ace. They pick up and use items too.
- **Zoom** the world in or out in whole-pixel steps, so the pixel art stays sharp. The HUD
  keeps its size at every level, and your choice is remembered.
- Hull damage, wrecks and respawns, lap and race records, an attract-mode race behind the menu.
- All art is generated in code at start-up and all sound is synthesised, so there are no
  image or audio files to load.

### Controls

| | Keyboard | Phone / tablet |
|---|---|---|
| Fly | Arrow keys or WASD (turn, thrust, brake/reverse) | Left thumb: push the stick the way you want to go |
| Fire weapon | Space (or X / J) | FIRE button |
| Brake | Down / S | BRAKE button |
| Do-over | E or Shift | DO-OVER button (appears while you hold one) |
| Zoom | Z cycles normal / wide / close; + and - or the mouse wheel step through every level | ZOOM button |
| Pause | P or Esc | II button |
| Menu | Arrows, Enter | Tap |
| Other | M mute, C CRT filter, F fullscreen, N pilot name, T world top 10 | FULLSCREEN, PILOT, TOP 10 buttons |

A gamepad also works (stick or d-pad to turn, A to thrust, B to brake, X to fire, Y or LB for
a do-over, Back to zoom, Start to pause).

On phones the game uses larger pixels, keeps the HUD clear of notches, and can be added to
the home screen as a full-screen app. Landscape gives the best view.

## Run it locally

Needs Node.js 20 or newer.

```bash
npm install
npm run dev        # http://localhost:8080, leaderboard kept in memory
npm test           # API tests, plus browser tests of the game if Playwright is installed
```

The browser tests drive the real game in headless Chromium (AI races on every course, zoom,
do-over). They need `npm install --no-save playwright && npx playwright install chromium`
and are skipped without it.

The game itself is static. Opening `public/index.html` straight from disk also works; it
just plays without the online leaderboard.

## Deploy to Google Cloud Run

Needs the [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in, and a project
with billing enabled.

```bash
gcloud auth login
PROJECT=your-project-id ./deploy.sh
```

The script is safe to re-run. It:

1. enables the Cloud Run, Cloud Build, Artifact Registry and Firestore APIs,
2. creates the project's default Firestore database (Native mode) if there isn't one,
3. creates a `rocketracer-run` service account that may only read and write Firestore,
4. builds the container from the `Dockerfile` with Cloud Build and deploys it as the public
   `rocketracer` service,
5. prints the URL.

Options, as environment variables: `REGION` (default `us-central1`), `SERVICE`
(default `rocketracer`), `FIRESTORE_LOCATION` (default `nam5`; permanent once the database
exists).

The service scales to zero when nobody is playing and is capped at three instances.

## CI/CD and staging

There are two copies of the game in the same Google Cloud project:

| | Service | Leaderboard | Updated by |
|---|---|---|---|
| **Production** | `rocketracer` | Firestore collection `rocketracer` | every merge to `main`, after staging passes |
| **Staging** | `rocketracer-staging` | separate collection `rocketracer-staging` | every merge to `main`, or any branch on request |

Staging says **STAGING BUILD** on its title screen, and both show the commit they are running
in the top-right corner (also at `/api/health`), so you can always tell what is deployed.

`.github/workflows/ci-cd.yml` runs on GitHub Actions:

- **Pull requests**: syntax check, all tests, build the container and check that it boots.
  No cloud access.
- **Push to `main`**: the same tests, then **staging**, then **production**. The image is built
  once; production gets the exact image staging just proved.
- **Try a branch first**: Actions tab > CI/CD > Run workflow > pick your branch (or
  `gh workflow run ci-cd.yml --ref my-branch`). That tests it and puts it on staging only.

Every rollout, on either service, goes through `tools/ci-deploy.sh`: deploy a revision that gets
**no traffic**, smoke-test it on a private URL (right commit, right environment, a Firestore read,
the page loads), and only then switch traffic. If a check fails, the previous revision keeps
serving and the pipeline stops, so a bad build never reaches production.

It logs in to Google with Workload Identity Federation, so there are no keys or secrets to
store or rotate. Google accepts the production deploy account only from this repository's `main`
branch; the staging one from any branch of this repository. Each can only roll out its own
service.

### One-time setup

After the first `./deploy.sh`:

```bash
PROJECT=your-project-id ./tools/setup-cicd.sh
```

It creates the staging service (a few minutes: it builds from your checkout), the image repo and
the two deploy accounts, then prints six values. Add them under Settings > Secrets and variables >
Actions as repository **variables** (recommended) or **secrets**: `GCP_PROJECT_ID`, `GCP_REGION`,
`WIF_PROVIDER`, `DEPLOYER_SA`, `STAGING_WIF_PROVIDER`, `STAGING_DEPLOYER_SA`. Then merge to
`main`.

Worth switching on in GitHub:

- Settings > Branches: require a pull request and the **Test** check before merging to `main`.
- Settings > Environments > production: add yourself as a required reviewer, and each release
  waits for your click after staging is updated, so you can try it there first. (On private
  repositories this needs a paid GitHub plan; without it, production follows staging
  automatically.)

### Rolling back

Send traffic to an earlier revision:

```bash
gcloud run revisions list --service rocketracer --region us-central1
gcloud run services update-traffic rocketracer --region us-central1 --to-revisions REVISION=100
```

The next pipeline run (or `./deploy.sh`) moves traffic back to the newest revision by itself.

## Backend

`server.js` is a dependency-light Node server (the only package is the Firestore client).

| Endpoint | |
|---|---|
| `GET /` | the game, from `public/` |
| `GET /api/health` | `{ ok, store, env, version }`: which environment and commit answered |
| `GET /api/scores?track=lunar` | top 10 race times for a course. With an `X-Pilot-Id` header it also returns `me`: that player's own row and world rank |
| `POST /api/scores` | submit a finished race: `{ track, pid, name, time, lap, diff, place }` |

Leaderboard rows live in Firestore at `rocketracer/{track}/scores/{pid}`. Each player has an
anonymous id generated in their browser and keeps one row per course, replaced only by a
faster time. A row records the time, best lap, rival level and `place`: where the pilot finished
in that race (1 to 6). The top-10 screen shows it, and shows your own row and rank underneath
when you are not in the top 10.

Configuration, all optional environment variables:

| Variable | Default | |
|---|---|---|
| `STORE` | `firestore` on Cloud Run, `memory` elsewhere | where scores are kept |
| `LEADERBOARD_COLLECTION` | `rocketracer` | Firestore collection; staging uses its own |
| `APP_ENV` | `production` | anything else puts a badge on the title screen |
| `COMMIT_SHA` | `dev` | set by the pipeline; reported by `/api/health` |

Submissions are validated (known course, plausible times, sanitised name) and rate-limited,
but times are reported by the browser, so treat the board as friendly competition rather
than tamper-proof.

(There is no `/healthz`: Cloud Run answers paths ending in `z` itself, before the app sees them.)

## Project layout

```
public/               the game (static)
  index.html, style.css, manifest.webmanifest, icons/
  src/core.js         math, noise, palette, pixel helpers, bitmap font
  src/art.js          procedural sprites: ships, planets, asteroids, donuts
  src/audio.js        chip-synth sound effects and music
  src/input.js        keyboard, touch stick, gamepad
  src/net.js          leaderboard client
  src/tracks.js       course definitions and builder
  src/game.js         physics, weapons, AI, laps, game states
  src/render.js       world, HUD, menus
  src/main.js         the two canvas layers (zooming world, fixed-size HUD) and main loop
server.js             static files + leaderboard API
lib/store.js          Firestore and in-memory leaderboard storage
test/api.test.js      API tests
test/game.test.js     browser tests of the game (Playwright)
.github/workflows/    CI/CD pipeline
Dockerfile, deploy.sh Cloud Run packaging and first deployment (STAGING=1 for the staging copy)
tools/setup-cicd.sh   one-time setup: staging service and keyless deploy access
tools/ci-deploy.sh    one safe rollout: no-traffic revision, smoke test, switch traffic
tools/make-icons.js   regenerates the app icons from the game art
```
