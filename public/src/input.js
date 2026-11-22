/* ==========================================================================
 * ROCKET RACER — input.js
 * Keyboard, touch and gamepad, folded into one small API:
 *   RR.input.read(ship)    -> { turn, thrust, brake, fire, aim, stick } for the player
 *   RR.input.hit[action]   -> true for the frame an action key went down
 *   RR.input.taps          -> pointer presses this frame, in game pixels
 *
 * Touch play:
 *   steer stick fixed bottom left, the fire stick's mirror image (movable in
 *               Pause > Move controls). The rocket heads the way it is
 *               pushed; how far it is pushed is the engine power, full at
 *               the rim, none in the middle STEER_DEAD.
 *   steering    or touch anywhere that is not another control and drag. The
 *               direction of the drag is where the rocket heads; how far you
 *               drag from where you started is the engine power, rising to
 *               full at DRAG_MAX. Past that the start point trails the thumb,
 *               so easing back always lowers the power straight away.
 *   fire stick  fixed in place (movable in Pause > Move controls). The
 *               blaster is automatic: it fires all the time the stick is
 *               held, straight ahead until the stick is pushed, then the way
 *               it is pushed. Missiles are aimed: push the stick the way to
 *               fire and let go to launch (let go without pushing: straight
 *               ahead). Mines and EMP go off as the stick is touched.
 *   BRAKE       a button.
 *   GAS         a button just above BRAKE: full engine power while held, the
 *               way the rocket points (or is being steered), so it speeds
 *               up steadily to its top speed.
 *
 * Keyboard aim: holding A or D swings the guns (blaster, cannon, missiles)
 * left or right at AIM_RATE, starting from where the rocket's nose points
 * as the key goes down. While it is held the guns keep their direction in
 * space, however the rocket turns; Space fires that way. Let go and they
 * point straight ahead again (and the aim line goes). In the menus A and D
 * mean left and right.
 *
 * Keys and touch work together (an iPad with a keyboard, say): both always
 * fly the ship, and a held turn key out-steers a drag. A key press puts the
 * keyboard prompts up and takes the touch controls off the screen, but not
 * while a thumb is flying with them or has been in the last KEEP_TOUCH_MS,
 * so steering with a drag and firing with Space works, and the controls do
 * not flicker away under a thumb.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR;
  const I = (RR.input = {
    down: {}, hit: {}, taps: [],
    pointers: {}, // id -> { x, y, sx, sy, role, touch } in game pixels (sx, sy = where it began; touch: a finger or pen, not a mouse)
    touch: { drag: null, aimStick: null, aim: null, brake: false, gas: false, fire: false },
    touchMode: false,
    controlAt: -Infinity, // performance.now() when a thumb was last on the race controls (steering, fire stick, brake)
    typing: false, // true while an HTML text field has the keyboard
  });

  const KEEP_TOUCH_MS = 10000; // after a thumb leaves the race controls, keys leave them on screen this long
  I.KEEP_TOUCH_MS = KEEP_TOUCH_MS;

  const KEYS = {
    ArrowLeft: 'left', ArrowRight: 'right', KeyA: 'aimL', KeyD: 'aimR', // A / D: aim the guns
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    Space: 'fire', KeyX: 'fire', KeyJ: 'fire',
    Enter: 'ok', NumpadEnter: 'ok',
    Escape: 'pause', KeyP: 'pause',
    KeyM: 'mute', KeyC: 'crt', KeyR: 'restart', KeyQ: 'quit',
    KeyN: 'name', KeyT: 'board', KeyF: 'full', KeyH: 'hangar', KeyO: 'online',
    KeyE: 'defer', ShiftLeft: 'defer', ShiftRight: 'defer', // gate deferral
    KeyZ: 'zoom', Equal: 'zoomIn', NumpadAdd: 'zoomIn', Minus: 'zoomOut', NumpadSubtract: 'zoomOut',
  };

  /*
   * Which key, as a KeyboardEvent.code name. Most browsers fill in e.code;
   * iPad Safari with a hardware keyboard may leave it empty or "Unidentified"
   * and name the arrows "UIKeyInputLeftArrow" and so on, so fall back on
   * e.key and then on the old keyCode.
   */
  const BY_KEY = {
    ArrowLeft: 'ArrowLeft', Left: 'ArrowLeft', UIKeyInputLeftArrow: 'ArrowLeft',
    ArrowRight: 'ArrowRight', Right: 'ArrowRight', UIKeyInputRightArrow: 'ArrowRight',
    ArrowUp: 'ArrowUp', Up: 'ArrowUp', UIKeyInputUpArrow: 'ArrowUp',
    ArrowDown: 'ArrowDown', Down: 'ArrowDown', UIKeyInputDownArrow: 'ArrowDown',
    ' ': 'Space', Spacebar: 'Space', Enter: 'Enter', Escape: 'Escape', Esc: 'Escape', UIKeyInputEscape: 'Escape',
    Shift: 'ShiftLeft', '=': 'Equal', '+': 'Equal', '-': 'Minus',
  };
  const BY_KEYCODE = {
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 32: 'Space', 13: 'Enter', 27: 'Escape',
    16: 'ShiftLeft', 187: 'Equal', 189: 'Minus', 107: 'NumpadAdd', 109: 'NumpadSubtract',
  };
  function codeOf(e) {
    if (e.code && e.code !== 'Unidentified') return e.code;
    const key = e.key || '';
    if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
    if (BY_KEY[key]) return BY_KEY[key];
    const kc = e.keyCode || e.which || 0;
    if (kc >= 65 && kc <= 90) return 'Key' + String.fromCharCode(kc);
    return BY_KEYCODE[kc] || '';
  }
  I.codeOf = codeOf;

  window.addEventListener('keydown', function (e) {
    if (I.typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = KEYS[codeOf(e)];
    if (!k) return;
    e.preventDefault();
    RR.audio.init();
    if (!e.repeat) I.hit[k] = true;
    I.down[k] = true;
    if (performance.now() - I.controlAt > KEEP_TOUCH_MS) I.touchMode = false; // keyboard prompts, no touch controls
  });
  window.addEventListener('keyup', function (e) {
    const k = KEYS[codeOf(e)];
    if (k) I.down[k] = false;
  });
  window.addEventListener('blur', function () {
    I.down = {};
    I.pointers = {};
  });
  // Every finger is off the glass: forget any touch whose lift never arrived
  // (a system gesture can swallow it), so it cannot go on steering.
  ['touchend', 'touchcancel'].forEach(function (ev) {
    window.addEventListener(ev, function (e) {
      if (e.touches && e.touches.length) return;
      for (const id in I.pointers) if (I.pointers[id].touch) delete I.pointers[id];
    }, { passive: true });
  });
  // The end of a gesture (finger lift, click) is when phones allow sound and full screen.
  ['pointerup', 'touchend', 'click'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      RR.audio.init();
      if (RR.game && RR.game.onGestureEnd) RR.game.onGestureEnd();
    }, { passive: true });
  });

  // Phones and tablets start in touch mode so the very first screen says "tap".
  try {
    I.touchMode = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  } catch (e) { /* keep keyboard prompts */ }

  /**
   * Give the game canvas the keyboard focus. iPad Safari sends a hardware
   * keyboard's keys only to a focused element, and a page with nothing
   * focused gets none. Not while an HTML text field is taking the typing.
   */
  I.focus = function () {
    const c = I.canvas;
    if (!c || I.typing || document.activeElement === c) return;
    try { c.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
  };

  /** Hook pointer events on the game canvas. */
  I.attach = function (canvas) {
    I.canvas = canvas;
    I.focus();
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * canvas.width,
        y: ((e.clientY - r.top) / r.height) * canvas.height,
      };
    }
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      RR.audio.init();
      I.focus();
      const p = pos(e), touch = e.pointerType === 'touch' || e.pointerType === 'pen';
      if (touch) I.touchMode = true;
      I.pointers[e.pointerId] = { x: p.x, y: p.y, sx: p.x, sy: p.y, role: null, touch: touch };
      I.taps.push(p);
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      }
    });
    canvas.addEventListener('pointermove', function (e) {
      const p = I.pointers[e.pointerId];
      if (!p) return;
      const q = pos(e);
      p.x = q.x; p.y = q.y;
    });
    const up = function (e) { delete I.pointers[e.pointerId]; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // mouse wheel / trackpad scroll zooms, one step per flick
    let wheelAt = 0;
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const now = performance.now();
      if (now - wheelAt < 180 || !e.deltaY) return;
      wheelAt = now;
      I.hit[e.deltaY < 0 ? 'zoomIn' : 'zoomOut'] = true;
    }, { passive: false });
  };

  function inside(x, y, r, pad) {
    return x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;
  }

  function near(x, y, c) { return Math.hypot(x - c.x, y - c.y) <= c.grab; }

  /** Where a thumb is on a fixed stick: knob offset (kept inside the rim), push 0..1, direction. */
  function stickState(p, c) {
    let dx = p.x - c.x, dy = p.y - c.y;
    const m = Math.hypot(dx, dy);
    if (m > c.r) { dx *= c.r / m; dy *= c.r / m; }
    return { x: c.x, y: c.y, dx: dx, dy: dy, mag: Math.min(1, m / c.r), ang: Math.atan2(dy, dx) };
  }

  const AIM_DEADZONE = 0.3; // fire stick pushed less than this: fire straight ahead
  const AIM_RATE = 2.6; // radians a second the guns swing while A or D is held
  I.AIM_RATE = AIM_RATE;
  I.aimDir = null; // keyboard aim: the guns' direction in space while A or D is held (null: straight ahead)

  /**
   * Once a frame while racing: with A or D held the guns start where `ship`
   * points and swing from there, keeping their direction in space as the
   * ship turns; with neither held (or both) they point straight ahead.
   */
  I.updateAim = function (dt, ship) {
    const l = !!I.down.aimL, r = !!I.down.aimR; // (a key never pressed is undefined)
    if (l === r || !ship) { I.aimDir = null; return; }
    if (I.aimDir == null) I.aimDir = ship.angle; // a fresh press: straight ahead
    I.aimDir += (r ? 1 : -1) * AIM_RATE * dt;
    I.aimDir = Math.atan2(Math.sin(I.aimDir), Math.cos(I.aimDir));
  };
  const STEER_DEAD = 0.15; // steering stick pushed less than this: no power
  I.STEER_DEAD = STEER_DEAD;

  /** The steering stick as a drag: the way it is pushed, and power from how far (`stick`: the knob). */
  function stickDrag(p, c) {
    const k = stickState(p, c);
    return {
      x: c.x, y: c.y, dx: k.dx, dy: k.dy, dist: k.mag * c.r, max: c.r, ang: k.ang, stick: k,
      power: k.mag <= STEER_DEAD ? 0 : (k.mag - STEER_DEAD) / (1 - STEER_DEAD),
    };
  }
  const DRAG_DEAD = 6; // game pixels a steering touch must move before it does anything, so a tap is not a burn
  const DRAG_MAX = 56; // game pixels from the starting point for full power
  I.DRAG_DEAD = DRAG_DEAD; I.DRAG_MAX = DRAG_MAX;

  /**
   * The steering drag for one finger: direction, and power 0..1 from how far
   * it is from where it started. Beyond DRAG_MAX the start point is pulled
   * along behind the thumb.
   */
  function dragState(p) {
    let dx = p.x - p.sx, dy = p.y - p.sy, m = Math.hypot(dx, dy);
    if (m > DRAG_MAX) {
      const k = (m - DRAG_MAX) / m;
      p.sx += dx * k; p.sy += dy * k;
      dx = p.x - p.sx; dy = p.y - p.sy; m = DRAG_MAX;
    }
    return {
      x: p.sx, y: p.sy, dx: dx, dy: dy, dist: m, max: DRAG_MAX, ang: Math.atan2(dy, dx),
      power: m <= DRAG_DEAD ? 0 : (m - DRAG_DEAD) / (DRAG_MAX - DRAG_DEAD),
    };
  }

  function onAny(x, y, rects) {
    for (let i = 0; rects && i < rects.length; i++) if (inside(x, y, rects[i], 0)) return true;
    return false;
  }

  /**
   * Work out the touch controls for this frame. `L` is RR.touchLayout() while
   * racing, or null when touch controls are not on screen; `buttons` are the
   * on-screen buttons (pause, zoom, defer), which a steering drag must not
   * start on. A finger keeps the role (steer / fire / brake) of wherever it
   * first landed.
   */
  I.updateTouch = function (L, buttons) {
    const t = I.touch;
    t.fire = t.brake = t.gas = false;
    t.drag = t.aimStick = t.aim = null;
    if (!L) {
      for (const id in I.pointers) I.pointers[id].role = 'menu';
      return;
    }
    for (const id in I.pointers) {
      const p = I.pointers[id];
      if (!p.role) {
        p.role = inside(p.sx, p.sy, L.brake, 6) ? 'brake'
          : inside(p.sx, p.sy, L.gas, 6) ? 'gas'
          : near(p.sx, p.sy, L.fire) ? 'fire'
          : near(p.sx, p.sy, L.steer) ? 'stick'
          : onAny(p.sx, p.sy, buttons) ? 'none'
          : 'steer'; // anywhere else on the screen
      }
      if (p.role === 'steer' || p.role === 'stick' || p.role === 'fire' || p.role === 'brake' || p.role === 'gas') I.controlAt = performance.now();
      if (p.role === 'brake') t.brake = true;
      else if (p.role === 'gas') t.gas = true;
      else if (p.role === 'stick' && !t.drag) t.drag = stickDrag(p, L.steer);
      else if (p.role === 'steer' && !t.drag) t.drag = dragState(p);
      else if (p.role === 'fire' && !t.aimStick) {
        t.fire = true;
        t.aimStick = stickState(p, L.fire);
        if (t.aimStick.mag > AIM_DEADZONE) t.aim = t.aimStick.ang;
      }
    }
  };

  function pad() {
    if (!navigator.getGamepads) return null;
    let pads;
    try { pads = navigator.getGamepads(); } catch (e) { return null; }
    for (let i = 0; pads && i < pads.length; i++) if (pads[i] && pads[i].connected) return pads[i];
    return null;
  }
  function btn(p, i) { return !!(p.buttons[i] && p.buttons[i].pressed); }

  /** Gamepad buttons that act once per press, folded into the same `hit` flags as keys. */
  const PAD_ACTIONS = { defer: [3, 4], zoom: [8], pause: [9] };
  const padWas = {};
  I.pollPad = function () {
    const p = pad();
    for (const name in PAD_ACTIONS) {
      const now = !!p && PAD_ACTIONS[name].some(function (b) { return btn(p, b); });
      if (now && !padWas[name]) I.hit[name] = true;
      padWas[name] = now;
    }
  };

  /** Player controls. `ship` is needed to turn the stick heading into a turn rate. */
  I.read = function (ship) {
    const d = I.down, t = I.touch;
    let turn = 0, thrust = 0, brake = 0, fire = false;
    if (d.left) turn -= 1;
    if (d.right) turn += 1;
    if (d.up) thrust = 1;
    if (d.down || t.brake) brake = 1;
    if (t.gas) thrust = 1; // GAS: full power
    if (d.fire || t.fire) fire = true;

    // steering drag: head the way it points, with as much engine as it is long
    // (a held turn key steers instead, so a forgotten thumb cannot fight the keys)
    const dr = t.drag;
    if (dr && dr.power > 0 && ship) {
      if (!d.left && !d.right) turn += RR.clamp(RR.angDiff(dr.ang, ship.angle) * 4.5, -1, 1);
      thrust = Math.max(thrust, dr.power);
    }

    const p = pad();
    if (p) {
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.18) turn += ax;
      if (btn(p, 14)) turn -= 1;
      if (btn(p, 15)) turn += 1;
      if (btn(p, 0) || btn(p, 7) || btn(p, 12)) thrust = 1;
      if (btn(p, 1) || btn(p, 6) || btn(p, 13)) brake = 1;
      if (btn(p, 2) || btn(p, 5)) fire = true;
    }
    // aim: the direction the fire stick points (or the guns, swung with A / D), or null to fire straight ahead;
    // stick: a thumb is on the touch fire stick (aimed weapons fire as it lets go); keyAim: aimed with A / D
    let aim = t.aim, keyAim = false;
    if (aim == null && I.aimDir != null && ship) { aim = I.aimDir; keyAim = true; }
    return { turn: RR.clamp(turn, -1, 1), thrust: thrust, brake: brake, fire: fire, aim: aim, stick: !!t.aimStick, keyAim: keyAim };
  };

  /** Short haptic tick on phones that support it. */
  I.buzz = function (ms) {
    if (!I.touchMode || !navigator.vibrate) return;
    try { navigator.vibrate(ms); } catch (e) { /* not allowed */ }
  };

  /** Call once at the end of every rendered frame. */
  I.endFrame = function () {
    I.hit = {};
    I.taps.length = 0;
  };
})();
