'use strict';

/** Pilot names use the game's bitmap font: A-Z, 0-9 and a little punctuation, at most 10 characters. */
function cleanName(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9 _.!-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10).trim();
  return s || 'PILOT';
}

module.exports = { cleanName };
