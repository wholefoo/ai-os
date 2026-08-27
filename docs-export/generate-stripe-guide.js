const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, LevelFormat, HeadingLevel,
        BorderStyle, WidthType, ShadingType, PageNumber, ExternalHyperlink } = require('docx');
const fs = require('fs');

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text, opts = {}) {
  return new TableCell({
    borders,
    width: { size: opts.width || 4680, type: WidthType.DXA },
    shading: opts.header ? { fill: "1e293b", type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!opts.header, color: opts.header ? "FFFFFF" : "1e293b", font: "Arial", size: opts.header ? 20 : 20 })] })],
  });
}

function heading(text, level) {
  return new Paragraph({ heading: level, spacing: { before: 300, after: 150 }, children: [new TextRun({ text, font: "Arial" })] });
}

function para(text, opts = {}) {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, font: "Arial", size: 22, ...opts })] });
}

function code(text) {
  return new Paragraph({
    spacing: { after: 120 },
    indent: { left: 360 },
    children: [new TextRun({ text, font: "Consolas", size: 20, color: "374151" })],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    children: [new TextRun({ text, font: "Arial", size: 22 })],
  });
}

function numbered(text) {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    children: [new TextRun({ text, font: "Arial", size: 22 })],
  });
}

const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 36, bold: true, font: "Arial", color: "1e293b" }, paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, font: "Arial", color: "1e293b" }, paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: "Arial", color: "374151" }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: {
      default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: "AI OS — Stripe Setup Guide (Confidential)", font: "Arial", size: 16, color: "9ca3af" })] })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Page ", font: "Arial", size: 16, color: "9ca3af" }), new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: "9ca3af" })] })] }),
    },
    children: [
      // Title
      heading("Stripe Setup Guide", HeadingLevel.HEADING_1),
      para("AI OS Orchestration Lab — Billing, Subscriptions & Payment Configuration"),
      para("This document is for internal/admin use only. It is not included in the customer-facing documentation.", { italics: true, color: "6b7280" }),
      new Paragraph({ spacing: { after: 200 }, children: [] }),

      // Subscription Tiers
      heading("Subscription Tiers", HeadingLevel.HEADING_2),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2000, 1840, 1840, 1840, 1840],
        rows: [
          new TableRow({ children: [cell("Feature", { header: true, width: 2000 }), cell("Pro $99/mo", { header: true, width: 1840 }), cell("Business $497/mo", { header: true, width: 1840 }), cell("Enterprise $1,997/mo", { header: true, width: 1840 }), cell("Lifetime $9,997", { header: true, width: 1840 })] }),
          new TableRow({ children: [cell("All 51 agents", { width: 2000 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 })] }),
          new TableRow({ children: [cell("White-label branding", { width: 2000 }), cell("No", { width: 1840 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 })] }),
          new TableRow({ children: [cell("Custom domain", { width: 2000 }), cell("No", { width: 1840 }), cell("No", { width: 1840 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 })] }),
          new TableRow({ children: [cell("Dedicated tenant", { width: 2000 }), cell("No", { width: 1840 }), cell("Subdomain", { width: 1840 }), cell("Full", { width: 1840 }), cell("Full", { width: 1840 })] }),
          new TableRow({ children: [cell("Omni Studio", { width: 2000 }), cell("No", { width: 1840 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 }), cell("Yes", { width: 1840 })] }),
          new TableRow({ children: [cell("Lifetime updates", { width: 2000 }), cell("While subscribed", { width: 1840 }), cell("While subscribed", { width: 1840 }), cell("While subscribed", { width: 1840 }), cell("Forever", { width: 1840 })] }),
        ],
      }),
      new Paragraph({ spacing: { after: 200 }, children: [] }),

      // Step 1
      heading("Step 1 — Create a Stripe Account", HeadingLevel.HEADING_2),
      numbered("Go to https://dashboard.stripe.com/register"),
      numbered("Sign up with your email"),
      numbered("Verify your email and complete onboarding"),

      // Step 2
      heading("Step 2 — Get Your Secret Key", HeadingLevel.HEADING_2),
      numbered("Go to https://dashboard.stripe.com/apikeys"),
      numbered("Click 'Reveal test key' next to Secret key (sk_test_...)"),
      numbered("Copy and paste into your .env file:"),
      code("STRIPE_SECRET_KEY=sk_test_XXXXXXXXXXXXXXXXXXXXXXXX"),
      para("Note: Start with test keys (sk_test_...). Switch to live keys (sk_live_...) when ready for real payments.", { italics: true, color: "6b7280" }),

      // Step 3
      heading("Step 3 — Create Products and Prices", HeadingLevel.HEADING_2),
      heading("Pro Plan ($99/month)", HeadingLevel.HEADING_3),
      numbered("Go to https://dashboard.stripe.com/products"),
      numbered("Click '+ Add product'"),
      numbered("Name: AI OS Pro"),
      numbered("Description: Full dashboard, 51 AI agents, Virtual HQ, SEO Agency"),
      numbered("Price: $99.00 / Monthly"),
      numbered("Save, then copy the Price ID (starts with price_)"),
      code("STRIPE_PRO_PRICE_ID=price_XXXXXXXXXXXXXXXXXXXXXXXX"),

      heading("Enterprise Plan ($1,997/month)", HeadingLevel.HEADING_3),
      numbered("Click '+ Add product' again"),
      numbered("Name: AI OS Enterprise"),
      numbered("Description: Everything + Omni Studio, YouTube Intel, white-label, custom domain"),
      numbered("Price: $1,997.00 / Monthly"),
      numbered("Save and copy the Price ID"),
      code("STRIPE_ENTERPRISE_PRICE_ID=price_XXXXXXXXXXXXXXXXXXXXXXXX"),

      heading("Lifetime License ($9,997 one-time)", HeadingLevel.HEADING_3),
      para("No Stripe product needed. The lifetime license is handled as a dynamic one-time Stripe Checkout session. The amount ($9,997) is set in LICENSE_CONFIG.tiers.lifetime.price in server.js."),

      // Step 4
      heading("Step 4 — Set Up the Webhook", HeadingLevel.HEADING_2),
      numbered("Go to https://dashboard.stripe.com/webhooks"),
      numbered("Click '+ Add endpoint'"),
      numbered("Endpoint URL: https://aiosorchestrationlab.com/api/stripe/webhook"),
      numbered("Select events:"),
      bullet("checkout.session.completed"),
      bullet("customer.subscription.updated"),
      bullet("customer.subscription.deleted"),
      bullet("invoice.payment_succeeded"),
      bullet("invoice.payment_failed"),
      numbered("Click 'Add endpoint'"),
      numbered("Click 'Reveal' under Signing secret, copy the whsec_... value"),
      code("STRIPE_WEBHOOK_SECRET=whsec_XXXXXXXXXXXXXXXXXXXXXXXX"),
      para("Important: The webhook endpoint receives raw request bodies (not JSON parsed) because Stripe requires the raw body for signature verification. This is already handled in server.js.", { italics: true, color: "6b7280" }),

      // Step 5
      heading("Step 5 — Complete .env Configuration", HeadingLevel.HEADING_2),
      code("# Stripe — Subscription paywall + License payments"),
      code("STRIPE_SECRET_KEY=sk_test_XXXXXXXXXXXXXXXXXXXXXXXX"),
      code("STRIPE_WEBHOOK_SECRET=whsec_XXXXXXXXXXXXXXXXXXXXXXXX"),
      code("STRIPE_PRO_PRICE_ID=price_XXXXXXXXXXXXXXXXXXXXXXXX"),
      code("STRIPE_ENTERPRISE_PRICE_ID=price_XXXXXXXXXXXXXXXXXXXXXXXX"),

      // Step 6
      heading("Step 6 — Restart and Test", HeadingLevel.HEADING_2),
      code("sudo -iu aios pm2 restart ai-os --update-env"),
      para(""),
      heading("Stripe Test Cards", HeadingLevel.HEADING_3),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [4680, 4680],
        rows: [
          new TableRow({ children: [cell("Card Number", { header: true }), cell("Result", { header: true })] }),
          new TableRow({ children: [cell("4242 4242 4242 4242"), cell("Successful payment")] }),
          new TableRow({ children: [cell("4000 0000 0000 3220"), cell("Requires 3D Secure")] }),
          new TableRow({ children: [cell("4000 0000 0000 0002"), cell("Card declined")] }),
          new TableRow({ children: [cell("4000 0000 0000 9995"), cell("Insufficient funds")] }),
        ],
      }),
      para("Use any future expiry, any 3-digit CVC, and any billing ZIP."),

      // Step 7
      heading("Step 7 — Go Live", HeadingLevel.HEADING_2),
      numbered("Complete Stripe account activation (business info, bank account for payouts)"),
      numbered("Toggle 'Test mode' off in the Stripe dashboard"),
      numbered("Copy the live keys (sk_live_..., whsec_...)"),
      numbered("Create the same products/prices in live mode (Price IDs will be different)"),
      numbered("Update your .env with all live keys"),
      numbered("Update the webhook endpoint to use live mode"),
      numbered("Restart: sudo -iu aios pm2 restart ai-os --update-env"),
      para("Before going live: Test the full checkout flow end-to-end with test cards. Verify the webhook fires correctly by checking pm2 logs ai-os.", { bold: true }),

      // Checkout flows
      heading("Checkout Flow — Subscriptions", HeadingLevel.HEADING_2),
      numbered("User clicks a pricing CTA on the landing page"),
      numbered("Server creates a Stripe Checkout Session via GET /api/stripe/checkout?plan=pro"),
      numbered("User is redirected to Stripe's hosted payment page"),
      numbered("After successful payment, Stripe redirects to success URL"),
      numbered("Server creates a session cookie and redirects to /app"),

      heading("Checkout Flow — Lifetime License", HeadingLevel.HEADING_2),
      numbered("Prospect submits application via POST /api/license/apply"),
      numbered("Admin reviews and approves in the Licensing dashboard"),
      numbered("Admin triggers payment link via POST /api/license/checkout/:id"),
      numbered("Stripe creates a $9,997 one-time Checkout Session"),
      numbered("After payment, admin marks participant as active — tenant auto-provisions"),

      // Webhook events
      heading("Webhook Events", HeadingLevel.HEADING_2),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [4680, 4680],
        rows: [
          new TableRow({ children: [cell("Event", { header: true }), cell("Action", { header: true })] }),
          new TableRow({ children: [cell("checkout.session.completed"), cell("Activate subscription or license")] }),
          new TableRow({ children: [cell("customer.subscription.updated"), cell("Update plan tier")] }),
          new TableRow({ children: [cell("customer.subscription.deleted"), cell("Revoke dashboard access")] }),
          new TableRow({ children: [cell("invoice.payment_succeeded"), cell("Confirm renewal, extend access")] }),
          new TableRow({ children: [cell("invoice.payment_failed"), cell("Notify user, enter grace period")] }),
        ],
      }),

      // Session management
      heading("Session Management", HeadingLevel.HEADING_2),
      bullet("Cookie name: ai-os-session"),
      bullet("Type: HTTP-only, Secure (production), SameSite: Lax"),
      bullet("Expiry: 30 days"),
      bullet("Content: Cryptographically random UUID token"),
      bullet("Validation: Server-side lookup maps token to email + plan + role + expiry"),
      bullet("Fallback: Bearer token via Authorization header (for API clients)"),
    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = "D:\\My Web Sites\\AI OS Orchestration Lab\\ai-os\\docs-export\\Stripe-Setup-Guide.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("Created:", outPath);
});
