#!/usr/bin/env node
/*
 * Regenerates the app icons in public/icons from the game's own pixel art.
 * Dev-only: needs Playwright and a running server.
 *
 *   npm run dev            # in one terminal
 *   node tools/make-icons.js [http://localhost:8080/]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2] || 'http://localhost:8080/';
  const out = path.join(__dirname, '..', 'public', 'icons');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.RR && window.RR.Art && window.RR.Art.donut);

  // [file, size, art scale, safe-zone padding as a fraction (maskable icons)]
  const icons = [['icon-180.png', 180, 1, 0], ['icon-192.png', 192, 1, 0], ['icon-512.png', 512, 1, 0], ['icon-maskable-512.png', 512, 0.74, 0]];
  for (const [file, size, zoom] of icons) {
    const dataUrl = await page.evaluate(([size, zoom]) => {
      const A = RR.Art, N = 128; // design the icon on a 128px pixel grid
      const c = RR.canvas(N, N), g = c.g;
      g.fillStyle = '#07071a'; g.fillRect(0, 0, N, N);
      g.drawImage(A.nebula(11, ['#110e38', '#1a1454', '#28196e', '#0d2148', '#11305e', '#164274']), -150, -200);
      g.drawImage(A.stars[1], 0, 0); g.drawImage(A.stars[2], -40, -60);
      g.translate(N / 2, N / 2); g.scale(zoom, zoom); g.translate(-N / 2, -N / 2);
      const d = A.donut.full;
      g.globalCompositeOperation = 'lighter'; g.drawImage(A.glow(62, '#ff6fb5'), 2, 2); g.globalCompositeOperation = 'source-over';
      g.drawImage(d, Math.round((N - d.width) / 2), Math.round((N - d.height) / 2));
      // the rocket bursting through the hole, drawn 3x
      const ship = A.ship(0, 0), big = RR.canvas(ship.width * 3, ship.height * 3);
      big.g.drawImage(ship, 0, 0, big.width, big.height);
      g.globalCompositeOperation = 'lighter'; g.drawImage(A.glow(20, '#ef7d57'), 28, 62); g.globalCompositeOperation = 'source-over';
      [['#5d275d', 34, 86], ['#b13e53', 38, 82], ['#ef7d57', 42, 78], ['#ffcd75', 46, 74], ['#ffffff', 49, 71]].forEach(([col, x, y]) => {
        g.fillStyle = col; g.fillRect(x, y, 5, 5);
      });
      RR.drawRot(g, big, N / 2 + 6, N / 2 - 6, Math.PI / 4);
      const o = document.createElement('canvas'); o.width = o.height = size;
      const og = o.getContext('2d'); og.imageSmoothingEnabled = false;
      og.drawImage(c, 0, 0, size, size);
      return o.toDataURL('image/png');
    }, [size, zoom]);
    fs.writeFileSync(path.join(out, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', file);
  }
  await browser.close();
})();
