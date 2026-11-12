/* ==========================================================================
 * ROCKET RACER — input.js
 * Keyboard, touch and gamepad, folded into one small API:
 *   RR.input.read(ship)    -> { turn, thrust, brake, fire, aim } for the player
 *   RR.input.hit[action]   -> true for the frame an action key went down
 *   RR.input.taps          -> pointer presses this frame, in game pixels
 *
 * Touch play uses two fixed thumb-sticks, which the player can move to suit
 * their hands (Pause > Move controls):
 *   steering stick  push the way you want to fly; the rocket turns to that
 *                   heading and burns
 *   fire stick      push it any way to aim and fire that way, whatever way
 *                   the rocket faces; hold it still in the middle to fire
 *                   straight ahead
 * plus a BRAKE button. A stick does not move with the thumb: touching on or
 * near it grabs it, and its knob goes as far as its rim.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR;
  const I = (RR.input = {
    down: {}, hit: {}, taps: [],
    pointers: {}, // id -> { x, y, sx, sy, role } in game pixels (sx, sy = where it began)
    touch: { stick: null, aimStick: null, aim: null, brake: false, fire: false },
    touchMode: false,
    typing: false, // true while an HTML text field has the keyboard
  });

  const KEYS = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    Space: 'fire', KeyX: 'fire', KeyJ: 'fire',
    Enter: 'ok', NumpadEnter: 'ok',
    Escape: 'pause', KeyP: 'pause',
    KeyM: 'mute', KeyC: 'crt', KeyR: 'restart', KeyQ: 'quit',
    KeyN: 'name', KeyT: 'board', KeyF: 'full', KeyH: 'hangar',
    KeyE: 'rewind', ShiftLeft: 'rewind', ShiftRight: 'rewind',
    KeyZ: 'zoom', Equal: 'zoomIn', NumpadAdd: 'zoomIn', Minus: 'zoomOut', NumpadSubtract: 'zoomOut',
  };

  window.addEventListener('keydown', function (e) {
    if (I.typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = KEYS[e.code];
    if (!k) return;
    e.preventDefault();
    RR.audio.init();
    if (!e.repeat) I.hit[k] = true;
    I.down[k] = true;
    I.touchMode = false;
  });
  window.addEventListener('keyup', function (e) {
    const k = KEYS[e.code];
    if (k) I.down[k] = false;
  });
  window.addEventListener('blur', function () {
    I.down = {};
    I.pointers = {};
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

  /** Hook pointer events on the game canvas. */
  I.attach = function (canvas) {
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
      const p = pos(e);
      if (e.pointerType === 'touch' || e.pointerType === 'pen') I.touchMode = true;
      I.pointers[e.pointerId] = { x: p.x, y: p.y, sx: p.x, sy: p.y, role: null };
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

  /**
   * Work out the touch controls for this frame. `L` is RR.touchLayout() while
   * racing, or null when touch controls are not on screen. A finger keeps the
   * role (steer / fire / brake) of wherever it first landed.
   */
  I.updateTouch = function (L) {
    const t = I.touch;
    t.fire = t.brake = false;
    t.stick = t.aimStick = t.aim = null;
    if (!L) {
      for (const id in I.pointers) I.pointers[id].role = 'menu';
      return;
    }
    for (const id in I.pointers) {
      const p = I.pointers[id];
      if (!p.role) {
        p.role = inside(p.sx, p.sy, L.brake, 6) ? 'brake'
          : near(p.sx, p.sy, L.fire) ? 'fire'
          : near(p.sx, p.sy, L.steer) ? 'steer' : 'none';
      }
      if (p.role === 'brake') t.brake = true;
      else if (p.role === 'steer' && !t.stick) t.stick = stickState(p, L.steer);
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
  const PAD_ACTIONS = { rewind: [3, 4], zoom: [8], pause: [9] };
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
    if (d.fire || t.fire) fire = true;

    const st = t.stick;
    if (st && st.mag > 0.24 && ship) {
      turn += RR.clamp(RR.angDiff(st.ang, ship.angle) * 4.5, -1, 1);
      thrust = 1;
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
    // aim: the direction the fire stick points, or null to fire straight ahead
    return { turn: RR.clamp(turn, -1, 1), thrust: thrust, brake: brake, fire: fire, aim: t.aim };
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
