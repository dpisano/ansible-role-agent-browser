// Prints the WebGL renderer the browser at the CDP endpoint (argv[2]) reports,
// as a website would read it. Opens and closes one blank tab; the browser keeps running.
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP(process.argv[2]);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  try {
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return 'no WebGL';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    });
    console.log(renderer);
  } finally {
    await page.close();
    // Disconnects; a browser attached over CDP is not closed.
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
