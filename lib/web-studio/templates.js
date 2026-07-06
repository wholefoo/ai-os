// lib/web-studio/templates.js
// ============================================================
//  Curated built-in Web Studio starter templates. A "template" is just a Web Studio PLAN (the same
//  JSON shape web-studio-lead emits: siteName/tokens/nav/footer/pages[].sections[]). When an operator
//  picks one to start a new site, the plan is fed to web-studio-lead as a structure to ANCHOR to — the
//  agents still run and tailor copy + design to the operator's brief (see pipeline.planPrompt's
//  templateRefBlock). So template copy here is intentionally generic-but-real scaffolding, not final
//  output; the section TYPES and page STRUCTURE are the load-bearing part.
//
//  IDs are prefixed 'builtin:' so they never collide with the uuid ids of user-saved templates, and so
//  the API/UI can treat built-ins as read-only (not deletable). Allowed section types (mirror the
//  renderer + planPrompt): hero, features, prose, cta, contact.
// ============================================================

const BUILTIN_TEMPLATES = [
  {
    id: 'builtin:saas-landing',
    name: 'SaaS Landing',
    category: 'SaaS Product',
    description: 'Single-page product launch: hero, feature grid, and a closing call to action.',
    plan: {
      siteName: 'Your Product',
      tokens: { brand: '#4f46e5', accent: '#06b6d4', ink: '#0f172a', paper: '#ffffff', fontDisplay: "'Inter', system-ui, sans-serif", fontBody: "'Inter', system-ui, sans-serif" },
      nav: [{ label: 'Features', href: '/#features' }, { label: 'Get started', href: '/#contact' }],
      footer: '© 2026 Your Product. All rights reserved.',
      pages: [
        { path: '/', title: 'Home', description: 'The fastest way to do the thing your product does — built for teams who care about outcomes.', sections: [
          { type: 'hero', heading: 'Ship faster with one clear tool', subheading: 'Replace the sprawl of point solutions with a single workspace your whole team actually uses.', cta: { label: 'Start free', href: '/#contact' } },
          { type: 'features', heading: 'Everything you need, nothing you don’t', items: [
            { title: 'Fast setup', body: 'Be up and running in minutes — no migration project required.' },
            { title: 'Built to scale', body: 'From your first project to your thousandth, performance stays steady.' },
            { title: 'Team-friendly', body: 'Roles, sharing, and audit trails so everyone stays in sync.' },
          ] },
          { type: 'cta', heading: 'Ready when you are', subheading: 'Start free today — no credit card, cancel anytime.', cta: { label: 'Create your account', href: '/#contact' } },
        ] },
      ],
    },
  },
  {
    id: 'builtin:business',
    name: 'Business / Agency',
    category: 'Business',
    description: 'Home + Services + Contact — a credible multi-page presence for a service business.',
    plan: {
      siteName: 'Your Company',
      tokens: { brand: '#0f766e', accent: '#f59e0b', ink: '#1c1917', paper: '#fafaf9', fontDisplay: "'Poppins', system-ui, sans-serif", fontBody: "'Inter', system-ui, sans-serif" },
      nav: [{ label: 'Home', href: '/' }, { label: 'Services', href: '/services' }, { label: 'Contact', href: '/contact' }],
      footer: '© 2026 Your Company.',
      pages: [
        { path: '/', title: 'Home', description: 'Practical, dependable service from a team that shows up and gets it done.', sections: [
          { type: 'hero', heading: 'Work with a team that delivers', subheading: 'Clear communication, honest pricing, and results you can point to.', cta: { label: 'Get a quote', href: '/contact' } },
          { type: 'features', heading: 'What we do well', items: [
            { title: 'Consultation', body: 'We start by understanding what success looks like for you.' },
            { title: 'Execution', body: 'A defined plan, steady updates, and work done right the first time.' },
            { title: 'Support', body: 'We stay available after the work ships — you’re not on your own.' },
          ] },
        ] },
        { path: '/services', title: 'Services', description: 'A closer look at how we help and what each engagement includes.', sections: [
          { type: 'prose', heading: 'Our services', body: 'Describe each core service, who it’s for, and what a typical engagement looks like from first call to final delivery.' },
          { type: 'cta', heading: 'Not sure where to start?', subheading: 'Tell us about your project and we’ll point you in the right direction.', cta: { label: 'Contact us', href: '/contact' } },
        ] },
        { path: '/contact', title: 'Contact', description: 'Get in touch to discuss your project — we reply within one business day.', sections: [
          { type: 'contact', heading: 'Let’s talk', subheading: 'Send a message and we’ll get back to you within one business day.' },
        ] },
      ],
    },
  },
  {
    id: 'builtin:portfolio',
    name: 'Portfolio',
    category: 'Portfolio',
    description: 'A clean personal or studio portfolio: intro hero, selected work, and contact.',
    plan: {
      siteName: 'Your Name',
      tokens: { brand: '#111827', accent: '#ec4899', ink: '#111827', paper: '#ffffff', fontDisplay: "'Fraunces', Georgia, serif", fontBody: "'Inter', system-ui, sans-serif" },
      nav: [{ label: 'Work', href: '/#work' }, { label: 'Contact', href: '/#contact' }],
      footer: '© 2026 Your Name.',
      pages: [
        { path: '/', title: 'Home', description: 'Selected work and a short introduction — available for new projects.', sections: [
          { type: 'hero', heading: 'Designer & maker', subheading: 'I help brands look and feel like themselves. Currently taking on select projects.', cta: { label: 'See the work', href: '/#work' } },
          { type: 'features', heading: 'Selected work', items: [
            { title: 'Project One', body: 'A one-line description of the project and the outcome it drove.' },
            { title: 'Project Two', body: 'What you made, for whom, and why it mattered.' },
            { title: 'Project Three', body: 'A short, concrete result — the kind a client would brag about.' },
          ] },
          { type: 'contact', heading: 'Start a project', subheading: 'Tell me what you’re working on and I’ll get back to you.' },
        ] },
      ],
    },
  },
  {
    id: 'builtin:restaurant',
    name: 'Restaurant / Local',
    category: 'Restaurant / Local',
    description: 'Warm single-page local business site: hero, highlights, and where to find you.',
    plan: {
      siteName: 'Your Restaurant',
      tokens: { brand: '#7c2d12', accent: '#ca8a04', ink: '#292524', paper: '#fffbeb', fontDisplay: "'Playfair Display', Georgia, serif", fontBody: "'Inter', system-ui, sans-serif" },
      nav: [{ label: 'Menu', href: '/#menu' }, { label: 'Visit', href: '/#contact' }],
      footer: '© 2026 Your Restaurant.',
      pages: [
        { path: '/', title: 'Home', description: 'Seasonal food, a warm room, and a welcome that keeps regulars coming back.', sections: [
          { type: 'hero', heading: 'Good food, made with care', subheading: 'A neighborhood table for everyday meals and small celebrations alike.', cta: { label: 'See the menu', href: '/#menu' } },
          { type: 'features', heading: 'What we’re known for', items: [
            { title: 'Seasonal menu', body: 'Dishes that change with what’s fresh and local.' },
            { title: 'Warm room', body: 'A comfortable space for a quick lunch or a long dinner.' },
            { title: 'Easy to visit', body: 'Walk-ins welcome; reservations for larger parties.' },
          ] },
          { type: 'contact', heading: 'Find us', subheading: 'Hours, address, and how to reach us for reservations.' },
        ] },
      ],
    },
  },
  {
    id: 'builtin:event',
    name: 'Event',
    category: 'Event',
    description: 'A focused event page: what/when/where hero, agenda highlights, and a register CTA.',
    plan: {
      siteName: 'Your Event',
      tokens: { brand: '#1d4ed8', accent: '#db2777', ink: '#0f172a', paper: '#ffffff', fontDisplay: "'Space Grotesk', system-ui, sans-serif", fontBody: "'Inter', system-ui, sans-serif" },
      nav: [{ label: 'Agenda', href: '/#agenda' }, { label: 'Register', href: '/#contact' }],
      footer: '© 2026 Your Event.',
      pages: [
        { path: '/', title: 'Home', description: 'One day, one place — the event for people who care about this topic.', sections: [
          { type: 'hero', heading: 'The event for [your audience]', subheading: 'A full day of talks, workshops, and the people you want to meet. [Date] · [City].', cta: { label: 'Register now', href: '/#contact' } },
          { type: 'features', heading: 'On the agenda', items: [
            { title: 'Keynotes', body: 'Big-picture talks from people worth listening to.' },
            { title: 'Workshops', body: 'Hands-on sessions you’ll actually use on Monday.' },
            { title: 'Networking', body: 'Structured time to meet peers, not just collect cards.' },
          ] },
          { type: 'cta', heading: 'Seats are limited', subheading: 'Register today to lock in your spot and early-bird pricing.', cta: { label: 'Get your ticket', href: '/#contact' } },
        ] },
      ],
    },
  },
];

module.exports = { BUILTIN_TEMPLATES };
