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

## CI/CD

`.github/workflows/ci-cd.yml` runs on GitHub Actions:

- **Pull requests**: install, syntax check, run all tests, build the container and check that it
  boots. No cloud access.
- **Push to `main`**: the same tests, then a deploy: build the image, push it to Artifact
  Registry, deploy it to Cloud Run as a revision that gets **no traffic**, smoke-test that
  revision (including a Firestore read), and only then send it traffic. If any check fails, the
  previous revision keeps serving.

It logs in to Google with Workload Identity Federation, so there are no keys or secrets to
store or rotate. Google trusts GitHub only for this repository's `main` branch, and the deploy
account can only push to one image repo and deploy this one service.

One-time setup, after the first `./deploy.sh`:

```bash
PROJECT=your-project-id ./tools/setup-cicd.sh
```

It prints four values (`GCP_PROJECT_ID`, `GCP_REGION`, `WIF_PROVIDER`, `DEPLOYER_SA`). Add them as
repository **variables** under Settings > Secrets and variables > Actions. Then merge to `main`.

Worth switching on in GitHub: Settings > Branches > require a pull request and the **Test**
check before merging to `main`, so nothing reaches Cloud Run without passing it.

To roll back, send traffic to an earlier revision:

```bash
gcloud run revisions list --service rocketracer --region us-central1
gcloud run services update-traffic rocketracer --region us-central1 --to-revisions REVISION=100
```

(After a rollback, the next deploy needs `--to-latest` to resume; the pipeline does that itself.)

## Backend

`server.js` is a dependency-light Node server (the only package is the Firestore client).

| Endpoint | |
|---|---|
| `GET /` | the game, from `public/` |
| `GET /api/health` | `{ ok, store }` |
| `GET /api/scores?track=lunar` | top 10 race times for a course |
| `POST /api/scores` | submit a finished race: `{ track, pid, name, time, lap, diff }` |
| `GET /healthz` | liveness probe |

Leaderboard rows live in Firestore at `rocketracer/{track}/scores/{pid}`. Each player has an
anonymous id generated in their browser and keeps one row per course, replaced only by a
faster time. `STORE=firestore` or `STORE=memory` picks the storage explicitly; by default
Firestore is used on Cloud Run and memory elsewhere.

Submissions are validated (known course, plausible times, sanitised name) and rate-limited,
but times are reported by the browser, so treat the board as friendly competition rather
than tamper-proof.

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
Dockerfile, deploy.sh Cloud Run packaging and first deployment
tools/setup-cicd.sh   one-time Google Cloud setup for the pipeline
tools/make-icons.js   regenerates the app icons from the game art
```
