/* ==========================================================================
 * ROCKET RACER — input.js
 * Keyboard, touch and gamepad, folded into one small API:
 *   RR.input.read(ship)    -> { turn, thrust, brake, fire } for the player
 *   RR.input.hit[action]   -> true for the frame an action key went down
 *   RR.input.taps          -> pointer presses this frame, in game pixels
 *
 * Touch play uses a floating thumb-stick: put a thumb down anywhere on the
 * left half and push the way you want to fly — the rocket turns to that
 * heading and burns. The right thumb gets FIRE and BRAKE buttons.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR;
  const I = (RR.input = {
    down: {}, hit: {}, taps: [],
    pointers: {}, // id -> { x, y, sx, sy, role } in game pixels (sx, sy = where it began)
    touch: { stick: null, brake: false, fire: false },
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

  /**
   * Work out the touch controls for this frame. `L` is RR.touchLayout() while
   * racing, or null when touch controls are not on screen. A finger keeps the
   * role (stick / fire / brake) of wherever it first landed.
   */
  I.updateTouch = function (L) {
    const t = I.touch;
    t.fire = t.brake = false;
    t.stick = null;
    if (!L) {
      for (const id in I.pointers) I.pointers[id].role = 'menu';
      return;
    }
    let sp = null;
    for (const id in I.pointers) {
      const p = I.pointers[id];
      if (!p.role) {
        p.role = inside(p.sx, p.sy, L.fire, 8) ? 'fire'
          : inside(p.sx, p.sy, L.brake, 6) ? 'brake'
          : inside(p.sx, p.sy, L.stick, 0) ? 'stick' : 'none';
      }
      if (p.role === 'fire') t.fire = true;
      else if (p.role === 'brake') t.brake = true;
      else if (p.role === 'stick' && !sp) sp = p;
    }
    if (sp) {
      let dx = sp.x - sp.sx, dy = sp.y - sp.sy;
      const m = Math.hypot(dx, dy), R = L.stickR;
      if (m > R) {
        // the base trails the thumb, so you never run out of travel
        const k = (m - R) / m;
        sp.sx += dx * k; sp.sy += dy * k;
        dx = sp.x - sp.sx; dy = sp.y - sp.sy;
      }
      t.stick = { x: sp.sx, y: sp.sy, dx: dx, dy: dy, mag: Math.min(1, m / R), ang: Math.atan2(dy, dx) };
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
    return { turn: RR.clamp(turn, -1, 1), thrust: thrust, brake: brake, fire: fire };
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
