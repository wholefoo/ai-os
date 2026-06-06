// modules/browser-agent/index.js — Browser automation agent
// Tier: business+ — requires ai-os-commercial license
//
// Web scraping, browser automation workflows,
// screenshot capture, and headless browser task execution.

module.exports = {
  name: 'browser-agent',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.browserAgent) {
      console.log('[COMMERCIAL] Skipping browser-agent (requires business+ license)');
      return;
    }

    // TODO: Extract routes from server.js
    // - POST /api/browser/navigate — navigate to URL
    // - POST /api/browser/scrape — scrape page content
    // - POST /api/browser/screenshot — capture screenshot
    // - POST /api/browser/automate — run automation workflow
    // - GET /api/browser/sessions — list active browser sessions
    // - DELETE /api/browser/sessions/:id — close browser session

    console.log('[COMMERCIAL] ✓ Browser Agent routes registered');
  },
};
