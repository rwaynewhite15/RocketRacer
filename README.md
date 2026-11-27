# Rocket Racer

A 2D rocket racing game in crisp, high-definition 8-bit style. Race five AI rivals, or your
friends online, around planets and through asteroid fields, threading giant donut checkpoints,
grabbing power-ups and firing weapons along the way.

It runs in any modern browser, plays well on phones, and ships with a small Google Cloud
backend: one Cloud Run service serves the game and a global leaderboard stored in Firestore,
and a second runs online multiplayer over WebSockets.

## The game

- **Four courses**: Lunar Loop (easy oval), Donut Drift (figure-eight through an asteroid
  belt), Gravity Gauntlet (planet slalom, orbiting rocks, long asteroid wall) and the
  **Indy-Galactic 500**, the easiest and fastest: five laps of a big oval flown flat out between
  rock walls.
  - **The walls** run along the inside and outside of a lane 280 pixels wide and keep everyone in:
    a ship that reaches one bounces off (a scrape is free, a hard knock dents the hull), and shots
    stop there. The walls are the lane's edges, exactly, so there are no gaps to slip through; the
    rocks along them are fixed scenery (online they are never sent, so they cost nothing).
  - **Just three donuts**: the start/finish line, and one on the far side of each end's world (the
    moon and the ice world in the infield). They are giants, two and a half times the usual size,
    as wide as the lane, and count anywhere on them, so any lane goes through.
  - **Seven lanes**, 38 pixels apart, which the rivals and the autopilot keep to. Rivals move over
    for a pickup they want, or two lanes over round a slower ship.
  - The pickups are spread over the lanes, so the lane matters: nitro in every other lane on each half
    of both straights, power-ups in the two outermost lanes going into each end, and (weapons on)
    crates in three of the lanes coming out of it. A wreck comes back on
    the lane where it happened, facing the way round. The edge arrow leads along the lane.
- **Donut checkpoints**: fly through every donut in order. The next one glows and an arrow
  at the screen edge points to it. The checkered donut is start/finish. Three laps (five on the
  Indy-Galactic 500).
- **Planets** are solid and pull on your rocket. **Asteroids** drift, bounce and can be shot.
- **Power-ups** (green capsules, used instantly): Nitro, Shield, Repair.
- **Gate deferral** (rare violet capsule, kept until you use it): marks the gate you are
  heading for as passed, so you go straight on to the next one. Your rocket stays where it is
  and the race clock isn't touched. While you hold one, a violet ring marks the gate it would
  defer. The start/finish line can't be deferred: every lap is still flown over the line (with
  the line next, the button dims, and pressing it says FLY THE LINE). Rivals can't use it.
- **Weapons** (red crates, one slot): Blaster, homing Missile, Mine, EMP shockwave.
- **A Grand Prix is flown by the autopilot** (unless you switch it off in the hangar: the ship page's
  AUTOPILOT, on to start with and remembered; off, a Grand Prix is flown by hand, GAS and all), so the
  fight has your full attention. It flies the ship round the course, flat out, and keeps to one of
  seven lanes, which you choose. On a touch screen the **lane slider** is the only control (no stick,
  no drag-to-steer): a tick for each lane, the knob on the lane you are in; drag it and the ship moves
  to the lane under your thumb, and stays there when you let go. On keys or a pad, LEFT and RIGHT move
  it a lane over per push, and on across the lanes while held. BRAKE (DOWN) still brakes; firing,
  aiming (A / D) and the gate deferral stay yours. There is no GAS in a race (the autopilot runs the
  engine), and a panel by the hull bar shows AUTO and which of the seven lanes it is in.
  It flies every course: on the walled oval it follows the lane; elsewhere it flies gate to gate the
  way the rivals do and eases back to each gate's middle as it comes, so it never misses one.
  Times go to the world tables either way, those the autopilot flew marked: a small steering wheel after the rocket in the SETUP column (the key under the table
  says AUTO), and AUTOPILOT beside the time on the pilot's card. Times set before the autopilot
  have no wheel. Online the player's own screen flies it, ahead of the server, like a player, and
  its inputs say so, so the server's record says so too. The fights (Dogfight, Battle Royale, Capture the
  Flag) have no course to follow and are flown by hand, as below.
- **Weapons on or off, for each course**: in a Grand Prix, WEAPONS sits beside RIVALS on the menu
  (UP / DOWN to it, LEFT / RIGHT, or tap ON / OFF). Off, the course's weapon crates stay away, so
  nobody (you or a rival) has anything to fire; the power-ups stay. Each course keeps its own
  setting, remembered; until you switch it, a course is as it was made: weapons on, except the
  Indy-Galactic 500, made without them. Online, a race room keeps the setting of whoever opened it,
  shown on the ONLINE screen and in the lobby (INDY-GALACTIC 500 - WEAPONS ON). Times go on the
  same table either way. The fights always have their weapons.
- **Rivals** in three skill levels: Rookie, Pilot, Ace. They pick up and use items too.
- **Four events**, chosen on the menu:
  - **Grand Prix**: the race described above.
  - **Dogfight**: no gates, just a walled arena. Every ship has a cannon that never runs dry;
    crates add missiles, mines and EMPs. Wrecks respawn. First to 5 kills wins, or the most
    kills when the 3-minute clock runs out.
  - **Battle Royale**: the same arenas with one life each. After 12 seconds a zone starts
    closing on the middle of the arena and burns any hull outside it, shield or not. Last ship
    flying wins. Once you are out, the camera follows a survivor.
  - **Capture the Flag**: teams of ships, each with a base and a flag, on five maps: three for
    **red against blue, three ships a side**, and two for **red, blue and green, two a side**
    (2 v 2 v 2). Offline you fly for red with AI teammates; online, players split between the
    teams and bots fill the seats.
    - **The Great Divide** (3 v 3): huge, 6600 by 3000, about nine arenas, a base at each end and
      a vast but light gas giant in the middle (it pulls, but never holds a ship that touches it).
    - **The Crossing** (3 v 3): small and quick, a slanting rock wall across the middle with a
      narrow gap at each end beside a planet.
    - **Twin Suns** (3 v 3): bases in opposite corners, a rock belt across the diagonal and a sun
      beyond each end of it to swing round.
    - **The Triad** (2 v 2 v 2): a round arena, three bases a third of the way round from each
      other, a ringed giant in the middle with rocks circling it, and a rock wall across the
      straight way between each pair of bases: squeeze past it on the inside or go the long way.
    - **Triple Crown** (2 v 2 v 2): a bigger round arena round a broken moon (a ball of rocks),
      with a world sitting on the straight way between each pair of bases.

    Every map is fair: with two teams one half is the other turned half way round, with three
    each third is the next turned a third of the way round. Fly into an enemy flag to take it
    and bring it to your own base to capture it, but only while your own flag is at home (with
    three teams, either enemy flag will do). A wrecked carrier drops the flag where it was hit;
    touching your own dropped flag sends it home, and a dropped flag goes home by itself after
    25 seconds. First to 3 captures wins, or the most when the 5-minute clock runs out (a tie
    at the top is a draw). Every ship has the cannon, there is no friendly fire (a team's mines
    never go off for it either), and wrecks respawn beside their own base after 4 seconds,
    twice a dogfight's wait, so a base cleared of defenders stays clear for a moment. The
    power-ups are the Grand Prix's, with **Replace Flag** (a gold capsule) instead of the gate
    deferral: E / Shift, or the FLAG button, sends your flag straight home even while an enemy
    is carrying it (your deferral upgrade sets how many uses it holds). There is only **one
    Replace Flag in the match**, lying on the map or held by one pilot: none appears while
    someone holds it, nobody else can pick one up, and a holder who is wrecked loses it (it
    comes back on the map later). The HUD shows which team holds it, never which pilot
    (REPLACE FLAG: BLUE TEAM). Flag news names the teams, and banners name the flag's team:
    GOT THE BLUE FLAG!, RED FLAG TAKEN BY GREEN!, BLUE CAPTURED THE RED FLAG, RED FLAG
    REPLACED!, and in the feed BLUE TEAM TOOK THE RED FLAG. The HUD shows every team's score,
    yours first, and an arrow at the screen's edge points to the job in hand: home while you
    carry a flag, whoever has stolen yours, a teammate carrying one, or else the flag to raid.
    The AI plays as a team, by a plan it rethinks twice a second and whenever a flag changes
    hands: one ship guards the base and drops its mines round the flag; the others raid, two
    of them splitting between the two ways round whatever is in between; a carrier runs for
    home round the enemy ahead, with its teammates flying cover; a thief is hunted by the two
    nearest ships, which cut it off at its own base when it has got away; and a loose flag is
    fetched by the nearest. With three teams, a raider picks the nearest free enemy flag,
    sooner one lying loose or the leading team's (taking it stops them scoring). Rivals plan
    their routes round planets, their pull and the asteroid fields, aim their guns (within a
    forward arc, misjudging a jinking target as a person would, the more so the lower the
    difficulty), pick up what helps on the way (the Replace Flag too, a short way off the
    route), and save Replace Flag for the moment it decides the point: a thief nearly home, or
    a teammate waiting at home with an enemy flag.
  A kill goes to whoever hit the ship in its last 5 seconds, even if a planet finished it off.
- **The hangar** (H on the menu): four ships with five stats each: Accel, Top Speed,
  Handling, Hull and Firepower (a weapon damage multiplier).
  - Finishing 1st, 2nd or 3rd in any event earns 3, 2 or 1 stat points; a win adds one more
    against Pilot rivals and two more against Ace.
  - Points raise a ship's stats up to that ship's ceiling. Every ship can spend all the
    points you have earned, and points can be taken back and moved at any time.
  - No point is ever unspendable: each ship sees only as many points as it has room for
    (Sparrow 15, Dart 19, Hammer 20, Phoenix 25), and points stop at the room of the best
    ship you have unlocked.
  - Wins unlock better ships with higher ceilings: the Dart (2 wins), the Hammer (5) and the
    Phoenix (9). The starting Sparrow flies exactly like the rivals' ships.
  - **Powerup upgrades** (the hangar's POWERUPS page): every finished event pays credits by
    place (100 for a win down to 30), times 1.5 against Pilot rivals and 2 against Ace.
    Credits buy upgrade points at 150 each. Like stat points, an upgrade point raises one
    powerup a level, up to level 3, and can be taken back and put on another at any time.
    Upgrades are kept for good and make every pick-up of that powerup stronger, in every
    event; rivals stay at level 1. Points can only be bought while some powerup still has
    room for them, so you never hold points you cannot spend.

    | Powerup | Level 1 / 2 / 3 gives |
    |---|---|
    | Nitro | a boost lasting 2.6 / 3.9 / 5.2 s |
    | Shield | a shield for 7 / 10.5 / 14 s |
    | Repair | +50 / +75 / +100 hull |
    | Blaster | 10 / 20 / 30 shots |
    | Missile | 2 / 3 / 5 missiles |
    | Mine | 3 / 5 / 8 mines |
    | EMP | 1 / 2 / 3 EMPs |
    | Gate deferral | 1 / 2 / 3 gates |
  - Progress is saved in the browser, like your records.
- **Zoom** the world in or out in whole-pixel steps, so the pixel art stays sharp. The HUD
  keeps its size at every level, and your choice is remembered.
- **High score tables for every event** (T on the menu, LEFT / RIGHT for the next table): the
  world top 10 race times for each course, and the world top 10 scores for each fight mode,
  one match's points:

  | Event | Points |
  |---|---|
  | Dogfight | 100 a kill, -25 a loss, 300 / 150 / 75 for 1st / 2nd / 3rd, and a win by kills scores 2 for every second still on the clock |
  | Battle Royale | 100 a kill, 500 / 300 / 200 / 100 / 50 for 1st to 5th |
  | Capture the Flag | 300 a flag captured, 100 a flag returned, 50 a kill, 300 when your team wins |

  all times 1.5 against Pilot rivals and 2 against Aces. Every row shows the pilot's rocket and
  the powerups they used, with a small 2 or 3 by an upgraded one; tap a row to see their whole
  setup with the race or the fight. A last table, **Top Pilots**, ranks pilots by wins in all
  events, with their games played and 1st, 2nd and 3rd places.
- **Pilot history** (Y on the menu): your games played, wins and 1st, 2nd and 3rd place finishes
  in each event and in all, and online your world rank by wins. A win is a 1st place, except in
  capture the flag, where it is your team's (the team with the most flags). It is kept with your
  progress in the browser, and on the server too.
- Hull damage, wrecks and respawns, lap and race records, an attract-mode race behind the menu.
- All art is generated in code at start-up and all sound is synthesised, so there are no
  image or audio files to load.

### Controls

| | Keyboard | Phone / tablet |
|---|---|---|
| Grand Prix (autopilot on) | LEFT / RIGHT change lane, one per push, sweeping on while held (the autopilot flies); DOWN or S brakes | The LANE slider, bottom left: the ship flies in the lane under your thumb, and stays there when you let go; BRAKE brakes |
| Fly (fights, and a Grand Prix with the autopilot off) | Arrow keys (turn, thrust, brake/reverse); W and S also thrust and brake | The FLY stick, bottom left (the fire stick's mirror image): the rocket heads the way you push it, and the farther you push, the more engine power (full at the rim). A quick tap on the stick (no push) swaps it for a slider: drag its knob left or right and the rocket turns that way, gently near the middle and harder towards the ends (a full turn only at the very end), and it springs back to the middle when you let go (use GAS to go); the STICK tab above it swaps back, and the choice is remembered. Or touch anywhere else and drag: the rocket heads the way you drag, and the farther you drag from where you started, the more power. A power meter shows the power (above the stick, or by your thumb) and fills to MAX; ease back to throttle down, lift to coast |
| Fire weapon | Space (or X / J): fires the way the guns point; hold it for the blaster's automatic fire. Hold A or D to swing the guns (blaster, cannon and missiles) left or right, starting from straight ahead, with a dashed line showing the aim; while you hold it the guns keep pointing the same way in space however the rocket turns; let go and they point straight ahead again and the line goes. In the menus A and D still mean left and right | Fire stick. Blaster: automatic, firing all the time you hold the stick, straight ahead until you drag it, then the way you drag. Missiles: hold the stick, drag the way to fire (a faint dashed line shows the aim and corner marks show the rival it will lock onto), and let go to launch; a quick tap launches straight ahead. Mines drop behind and EMP spreads all round as soon as you touch the stick |
| Brake | Down / S | BRAKE button, to the left of GAS |
| Gas | Up / W | GAS button, just above the fire stick (not in a Grand Prix on the autopilot, which runs the engine): full engine power, the way the rocket points (or is being steered), so it speeds up steadily to its top speed. Hold it for gas until you let go, or tap it to keep it on (lit GAS ON) until you tap it again; a hold also turns a tapped-on GAS off. Every race starts with it off |
| Gate deferral | E or Shift | DEFER button (appears while you hold one) |
| Zoom | Z cycles normal / wide / close; + and - or the mouse wheel step through every level | ZOOM button |
| Pause | P or Esc | II button |
| Move the controls | | Pause > MOVE CONTROLS: drag the FLY and fire sticks and the buttons where you like (kept separately for sideways and upright; RESET restores them). GAS, BRAKE and DEFER follow the fire stick wherever it goes, unless you move them yourself |
| Menu | Arrows, Enter | Tap |
| Hangar | H on the menu; up/down move through the ship, its stats, AUTOPILOT, BUY and the powerups (the page turns to POWERUPS past AUTOPILOT), left/right pick a ship, spend and take back points, or switch the autopilot; Enter closes | HANGAR button; SHIP and POWERUPS pages; arrows, the AUTOPILOT switch, BUY and - / + buttons |
| Online | O on the menu; LEFT / RIGHT switch between bots and humans only; Enter for Quick Match, then READY; L in a private room for its invite link; Esc leaves. In a race P opens a menu (the race goes on) | ONLINE button, then tap the bots line for humans only, QUICK MATCH, CREATE ROOM or JOIN ROOM, and READY; INVITE LINK in a private room; the II button opens the menu |
| Other | M mute, C CRT filter, F fullscreen, N pilot name, T high score tables (left / right for the next table; up / down and Enter open a pilot's setup), Y pilot history | FULLSCREEN, PILOT, TOP 10 (< and > for the next table; tap a pilot for their setup) and HISTORY buttons |

A gamepad also works (stick or d-pad to turn, A to thrust, B to brake, X to fire, Y or LB for
a gate deferral, Back to zoom, Start to pause).

Keys and touch work together, for example on an iPad with a keyboard: drag to steer and press
Space to fire, or steer with the arrows and use the fire stick. Playing with keys alone clears
the touch controls off the screen once your thumbs have been off them for 10 seconds; touch
anywhere to bring them back. A held turn key overrides a drag's steering. (iPad keyboards often
have no Esc key: P pauses. If the keys do nothing at first, tap the game once: Safari on iPad
only sends keys to a page that has been touched since it opened.)

On phones the game uses larger pixels, keeps the HUD clear of notches, and can be added to
the home screen as a full-screen app. Landscape gives the best view.

On iPhones and iPads the game does not use the browser's full screen: iPhones have none for web
pages, and on an iPad a downward swipe (which steering makes all the time) drops out of it, which
a page cannot switch off. Use Share > Add to Home Screen instead; the game then opens in its own
window, with no browser bars and no swipe-to-exit. The title screen says so, and F says so on an
iPad keyboard.

iOS 26 lays a Home Screen app out one status bar short (and draws nothing below that) while the
page is no taller than that short screen, which cut off the bottom of the game. `style.css`
makes the page at least screen-tall in an installed app, capped at the screen so it never
scrolls, and the game refits whenever the window's size changes, even without a resize event.

## Online multiplayer

ONLINE on the menu (when the game's server says online play is available):

- **Quick Match** joins anyone's room for the mode on the menu (Grand Prix, Dogfight, Battle
  Royale or Capture the Flag), or opens one. **Create room** gives a four-letter code for friends; **Join room** takes
  one. Up to six pilots; bots take the empty seats. The race starts when everyone is READY.
- **Humans only**: the line above the buttons says who takes the empty seats. Switch it (LEFT /
  RIGHT, or tap it) from bots at the menu's rival level to HUMANS ONLY - NO BOTS, and the rooms you
  open or quick-match into race people only. Quick Match keeps the two kinds of room apart, a room's
  lobby shows OPEN SEAT for each empty seat, and a race needs at least two pilots (alone, the lobby
  says WAITING FOR ANOTHER PILOT). A pilot who drops out is not replaced by a bot: their ship drifts
  with its engines off until they come back. With no rivals to beat, a humans-only room pays credits
  and scores at the middle (Pilot) rate. The choice is remembered.
- **Invite links**: a private room's lobby has an INVITE LINK button (L). It shows the room's link
  (`…/?room=ABCD`), with COPY and, where the device can, SHARE. Whoever opens it gets the pilot-name
  box first (JOIN ROOM ABCD), and JOIN takes them straight into the room; NOT NOW leaves them on the
  title screen. The link is taken out of the address bar once read, so a reload does not join twice.
- **Lending the best rocket**: the room's host (whoever opened it; the next pilot in if they leave)
  can tick LEND THEM A MAXED-OUT PHOENIX in that box. The link then carries the room's secret lend
  key (`&loan=…`), and whoever joins with it flies the best rocket there is, a Phoenix with every stat
  at its ceiling and every powerup upgraded to level 3, for as long as they are in the room. Their own
  hangar is never touched. The server checks the key (it is never shown to anyone but the host), so
  a link cannot be edited into a lending one.
- **Lent shows everywhere**: the lobby says LENT by a lent rocket (and LENT TO YOU: A MAXED-OUT
  PHOENIX to its pilot), the results say ZED (LENT), and what a pilot does in a lent rocket still
  goes on the world top 10 but marked: a gold `*` before the name (the key under the table says
  `* LENT ROCKET`), and on their card LENT by the rocket and LENT, MAXED OUT over the stats. Only
  the multiplayer server can mark a row lent; a page posting its own score cannot.
- Each pilot flies their own rocket from the hangar (unless an invite lent them one): hull, stat
  levels and powerup upgrades.
- Results pay credits and stat points as offline. Grand Prix times the player flew themselves go
  to the world top 10, marked online (the server timed them); so do fights' scores, for pilots
  no bot stood in for. The server also adds every game to the history of each pilot still there
  at the end.
- A dropped connection reconnects and gets the same ship back; a bot flies it meanwhile (in a
  humans-only room, nobody does).
- Every human pilot's name shows over their rocket on the grid and for the first 2 seconds of
  the race, and again for 2 seconds whenever their rocket comes into view (bots are never
  named). Offline, your own name shows at the start.

How it works:

- **The server is the authority.** It runs the very same game engine as the browser
  (`lib/engine.js` loads `core.js`, `records.js`, `art.js`, `tracks.js` and `game.js` headless, one isolated
  copy per room) at 120 steps a second. Players send only their controls (60 a second); the
  server sends the world back 20 times a second, with sounds and explosions as timed events.
  Nobody can cheat on positions, hits or times.
- **WebSockets** (TCP): Cloud Run has no UDP, and at 20 updates a second with smoothing on the
  client, TCP is fine for this game. Inputs (8 bytes) and snapshots (about 630 bytes, so about
  13 KB/s per player) are binary (`public/src/proto.js`); lobby messages are JSON.
- **On each screen** (`public/src/mp.js`) the player's own ship flies at once from their
  controls (prediction); each snapshot puts it where the server says and replays the controls
  the server has not used yet (reconciliation). Everyone else is drawn 100 ms in the past,
  smoothly between two snapshots (interpolation). A ping keeps the clocks in step.
- **No Kubernetes.** A room costs the server about 7 ms of CPU a second and a few MB, so one
  Cloud Run instance holds many rooms. All rooms live on that one instance (`--max-instances 1`)
  so friends always meet. When that is not enough: more CPUs, then more services, each its own
  shard, with a room list in Firestore.

## Run it locally

Needs Node.js 22 or newer.

```bash
npm install
npm run dev        # http://localhost:8080, leaderboard in memory, online play on /ws (try two browser windows)
npm test           # API tests, plus browser tests of the game if Playwright is installed
```

The browser tests drive the real game in headless Chromium (AI races on every course, zoom,
gate deferral, the hangar, dogfights and battle royales in every arena, capture the flag (the rules
for two and three teams, the single Replace Flag, the AI's teamwork, routes and Replace Flag timing,
bots playing every map, and two players online), the high score tables for every event and the
pilot history, and two players racing
online against the multiplayer server, also on a slow network). They need `npm install --no-save playwright && npx playwright install chromium`
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
| **Staging** | `rocketracer-staging` | separate collection `rocketracer-staging` | every push to `dev` or `main`, or any branch on request |

Staging says **STAGING BUILD** on its title screen, and both show the commit they are running
in the top-right corner (also at `/api/health`), so you can always tell what is deployed.

`.github/workflows/ci-cd.yml` runs on GitHub Actions:

- **Pull requests**: syntax check, all tests, build the container and check that it boots.
  No cloud access.
- **Push to `dev`**: the same tests, then **staging** only. `dev` is where changes wait to be
  tried out before they are released.
- **Push to `main`**: the same tests, then **staging**, then **production**. The image is built
  once; production gets the exact image staging just proved.
- **Try any other branch**: Actions tab > CI/CD > Run workflow > pick your branch (or
  `gh workflow run ci-cd.yml --ref my-branch`). That tests it and puts it on staging only.

The usual flow:

1. Work on a feature branch, and open a pull request into **`dev`**.
2. Merge it: staging updates itself. Try it there.
3. When `dev` plays right, open a pull request from **`dev` into `main`** and merge it: that
   releases to production.

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

It creates the staging service (a few minutes: it builds from your checkout), the online-play
services (`rocketracer-mp-staging` and `rocketracer-mp`), the image repo and the two deploy
accounts, then prints six values. Add them under Settings > Secrets and variables
> Actions, on the **Variables** tab (the Secrets tab works too): `GCP_PROJECT_ID`, `GCP_REGION`,
`WIF_PROVIDER`, `DEPLOYER_SA`, `STAGING_WIF_PROVIDER`, `STAGING_DEPLOYER_SA`. Then re-run the
workflow or merge to `main`. Each deploy job checks these first and names any that are missing
or malformed.

**Set up before online play existed?** Run the same command once more (it only adds what is
missing): it creates the two online-play services and points the game at them (`MP_URL`). Until
then the pipeline skips online play and the game shows no ONLINE button. The online-play
services run with: one instance (`--max-instances 1`: every room is in its memory),
`--min-instances 1` in production (no cold starts; `MP_MIN_INSTANCES=0` to save money) and 0 on
staging, CPU always on for the race loop (`--no-cpu-throttling`), `--timeout 3600` (WebSocket
connections last up to an hour; the game reconnects), `--session-affinity`, 2 CPUs and 1 GiB.
Production's always-on instance costs about as much as a small always-on VM.

Worth switching on in GitHub:

- Settings > Branches: require a pull request and the **Test** check before merging to `main`.
- Settings > Environments > production: add yourself as a required reviewer, and each release
  waits for your click after staging is updated, so you can try it there first. (On private
  repositories this needs a paid GitHub plan; without it, production follows staging
  automatically.)

### When a run fails

- **"Deploy settings" errors**: the six values above are missing or mistyped. The message names
  which; re-run `tools/setup-cicd.sh` to print them again.
- **"This workflow run required approval but was not approved before it expired"**: GitHub does
  not run Actions on pull requests opened by the Copilot agent (or from forks) until someone
  with write access clicks **Approve and run workflows** on the pull request. Nothing is broken;
  approve and re-run it, or ignore it if the pull request is closed.
- **Permission denied from Google** after login works: re-run `tools/setup-cicd.sh`; it re-applies
  every grant and is safe to repeat.

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
| `GET /api/config` | `{ mp }`: where online play is (`MP_URL`, or `/ws` with `MP=embedded`), or `null` |
| online-play service: `GET /api/health`, WebSocket `/ws` | `mp-server.js` (see Online multiplayer). Online times are stored with `online: true` |
| `GET /api/scores?track=lunar` | a high score table's top 10: a course's race times (`lunar`, `eight`, `gauntlet`, `indy`), or a fight mode's scores (`dogfight`, `royale`, `ctf`). With an `X-Pilot-Id` header it also returns `me`: that player's own row and world rank |
| `POST /api/scores` | submit a finished race: `{ track, pid, name, time, lap, diff, place, setup, auto }`, or a fight: `{ track: mode, pid, name, diff, map, result, setup }` (the server works out the points) |
| `GET /api/history?mode=all` | the 10 pilots with the most wins in all events (or one: `race`, `dogfight`, `royale`, `ctf`); with `X-Pilot-Id`, `me`: that player's whole history and rank |
| `POST /api/history` | one finished game for the player's history: `{ pid, name, mode, place, win }` (no closer than 5 seconds after their last) |

Leaderboard rows live in Firestore at `rocketracer/{track}/scores/{pid}`. A row made in a rocket an
invite link lent has `lent: true` (set only by the multiplayer server); a race time the autopilot flew
has `auto: true` (posted by the page, or online by the multiplayer server from the player's inputs;
rows from before it existed read false). Each player has an
anonymous id generated in their browser and keeps one row per course, replaced only by a
faster time. A row records the time, best lap, rival level, `place` (where the pilot finished
in that race, 1 to 6) and `setup`: `{ ship, stats, items, levels }`, the rocket flown, its
five stat levels, how many of each powerup were picked up and used (`items`), and the pilot's
powerup upgrade levels (`levels`: item -> 2 or 3; level 1 is left out). A powerup counts as
used when it takes effect: nitro, shield and repair on pick-up, a weapon at its first shot, a
gate deferral when a gate is deferred. (Rows from before the deferral replaced the do-over may
still list `rewind`; the game no longer shows it.)
The setup belongs to the record run, so a slower race leaves it alone. Rows from before either
field existed have `null`.

Each fight mode has its own table at `rocketracer/{mode}/scores/{pid}`, best score first, one row
per player replaced only by a better score. A row records the `score`, rival level, `map` (the
arena or flag map) and `result`: `{ place, win, kills, deaths }`, plus `left` (seconds left on a
dogfight's clock when it was won) or `caps` and `returns` (capture the flag). The rules live in
`public/src/records.js`, shared by the game and the server: the server checks that the result is
one the rules allow (no more kills than a dogfight lasts for or a royale has rivals, one life in a
royale, time left only on a win by kills, no more flags than end a match) and works out the points
itself, whatever the caller says.

Pilot histories live at `rocketracer/pilots/history/{pid}`: for each event and in all (`all`),
`{ played, wins, p1, p2, p3 }`. Games played offline are posted by the game (a few seconds apart);
online games are recorded by the multiplayer server, which saw them. The Top Pilots table orders
by wins.

The top-10 screen shows each pilot's rocket and the powerups they used most in the row, with a
small 2 or 3 beside one they had upgraded (`+` when there were more than three), and your own
row and rank underneath when you are not in the top 10. Tap a row (or pick it with the arrow
keys and press Enter) for that pilot's card: the rocket, its stat levels (grey: the ship's own,
yellow: points put in), and every powerup used, numbered the same way.

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
  src/input.js        keyboard, touch (drag to steer, fire stick), gamepad
  src/net.js          leaderboard and pilot history client
  src/proto.js        the online message format (shared with the server)
  src/records.js      high scores' points and pilot histories (shared with the server)
  src/mp.js           online play: connection, prediction, interpolation, lobby
  src/tracks.js       courses, arenas and flag maps, and the builder
  src/game.js         physics, weapons, AI, laps, combat modes, hangar, game states
  src/render.js       world, HUD, menus
  src/main.js         the two canvas layers (zooming world, fixed-size HUD) and main loop
server.js             static files + leaderboard API (+ online play with MP=embedded)
mp-server.js          the online-play service: rooms over WebSockets
lib/mp.js             rooms, matchmaking, the race loop, snapshots
lib/engine.js         the game engine run headless, one copy per room
lib/store.js          Firestore and in-memory storage: high score tables and pilot histories
test/api.test.js      API tests
test/game.test.js     browser tests of the game (Playwright)
test/engine.test.js   the headless engine
test/mp.test.js       the multiplayer server with real WebSocket clients
test/online.test.js   two browsers racing online
.github/workflows/    CI/CD pipeline
Dockerfile, deploy.sh Cloud Run packaging and first deployment (STAGING=1 for the staging copy)
tools/setup-cicd.sh   one-time setup: staging service and keyless deploy access
tools/ci-deploy.sh    one safe rollout: no-traffic revision, smoke test, switch traffic
tools/mp-smoke.js     smoke test for online play: a real room over the WebSocket
tools/make-icons.js   regenerates the app icons from the game art
```
