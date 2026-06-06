// org-chart/departments.js — Commercial-only departments and agents
// These 5 departments (36 agents) are added when a Business or Enterprise license is active.

const COMMERCIAL_DEPARTMENTS = [
  {
    id: 'board', name: 'Board of Directors', icon: '🏆', color: '#6366f1',
    employees: [
      { id: 'board-quality', title: 'Quality Director', name: 'Sentinel', agent: 'reviewer', tier: 'strategic', avatar: '🔍', status: 'active', reportsTo: 'ceo', desc: 'Code and content quality standards, review enforcement' },
      { id: 'board-security', title: 'Security Director', name: 'Aegis', agent: 'security-auditor', tier: 'strategic', avatar: '🛡️', status: 'active', reportsTo: 'ceo', desc: 'Security posture, vulnerability assessment, compliance' },
      { id: 'board-research', title: 'Research Director', name: 'Cipher', agent: 'research-architect', tier: 'professional', avatar: '🔬', status: 'active', reportsTo: 'ceo', desc: 'Research methodology, knowledge strategy, academic rigor' },
    ]
  },
  {
    id: 'creative', name: 'Creative Studio', icon: '🎨', color: '#ec4899',
    employees: [
      { id: 'creative-dir', title: 'Creative Director', name: 'Muse', agent: 'media-producer', tier: 'creative', avatar: '🎬', status: 'active', reportsTo: 'coo', desc: 'Media production pipeline, creative strategy, brand consistency' },
      { id: 'creative-design', title: 'UI/UX Designer', name: 'Pixel', agent: 'vibe-designer', tier: 'creative', avatar: '🎨', status: 'active', reportsTo: 'creative-dir', desc: 'Prompt-driven UI generation, predictive heat maps, interaction flows' },
      { id: 'creative-video', title: 'Video Producer', name: 'Reel', agent: 'video-creator', tier: 'creative', avatar: '🎥', status: 'active', reportsTo: 'creative-dir', desc: 'Video generation, editing, social clips, thumbnails' },
      { id: 'creative-3d', title: '3D Artist', name: 'Vertex', agent: 'blender-3d', tier: 'creative', avatar: '🧊', status: 'active', reportsTo: 'creative-dir', desc: 'Blender MCP text-to-3D environments and product renders' },
      { id: 'creative-audio', title: 'Audio Engineer', name: 'Sonance', agent: 'audio-producer', tier: 'creative', avatar: '🎵', status: 'active', reportsTo: 'creative-dir', desc: 'Voiceovers, music, sound effects, podcast audio' },
      { id: 'creative-brand', title: 'Brand Designer', name: 'Palette', agent: 'design-system', tier: 'professional', avatar: '🖌️', status: 'active', reportsTo: 'creative-dir', desc: 'Design systems, WCAG compliance, brand cloning, component specs' },
    ]
  },
  {
    id: 'customer-service', name: 'Customer Service', icon: '💬', color: '#f59e0b',
    employees: [
      { id: 'cs-lead', title: 'Support Lead', name: 'Harbor', agent: 'cs-lead', tier: 'professional', avatar: '🎧', status: 'active', reportsTo: 'coo', desc: 'Escalation management, ticket triage, satisfaction tracking' },
      { id: 'cs-tier1', title: 'Tier 1 Support', name: 'Compass', agent: 'cs-tier1', tier: 'scout', avatar: '💬', status: 'active', reportsTo: 'cs-lead', desc: 'First-response support, FAQ handling, basic troubleshooting' },
      { id: 'cs-tier2', title: 'Tier 2 Support', name: 'Resolve', agent: 'cs-tier2', tier: 'professional', avatar: '🔧', status: 'idle', reportsTo: 'cs-lead', desc: 'Complex issue resolution, technical investigation, bug reproduction' },
    ]
  },
  {
    id: 'tech-support', name: 'Tech Support & IT', icon: '🖥️', color: '#06b6d4',
    employees: [
      { id: 'it-lead', title: 'IT Director', name: 'Matrix', agent: 'it-director', tier: 'professional', avatar: '🖥️', status: 'active', reportsTo: 'cto', desc: 'Infrastructure oversight, system health, deployment coordination' },
      { id: 'it-sysadmin', title: 'System Administrator', name: 'Root', agent: 'sysadmin', tier: 'professional', avatar: '🔑', status: 'active', reportsTo: 'it-lead', desc: 'Server management, monitoring, uptime, security patches' },
      { id: 'it-helpdesk', title: 'Help Desk', name: 'Guide', agent: 'helpdesk', tier: 'scout', avatar: '🆘', status: 'idle', reportsTo: 'it-lead', desc: 'Internal support, tool provisioning, access management' },
    ]
  },
  {
    id: 'legal', name: 'Legal Department', icon: '⚖️', color: '#78716c',
    employees: [
      { id: 'legal-gc', title: 'General Counsel', name: 'Justice', agent: 'general-counsel', tier: 'strategic', avatar: '⚖️', status: 'active', reportsTo: 'ceo', desc: 'Chief Legal Officer — franchise agreements, IP protection, regulatory compliance, dispute resolution' },
      { id: 'legal-compliance', title: 'Compliance Officer', name: 'Shield', agent: 'compliance-officer', tier: 'professional', avatar: '🛡️', status: 'active', reportsTo: 'legal-gc', desc: 'GDPR/CCPA compliance, audit trails, policy enforcement, regulatory monitoring' },
      { id: 'legal-franchise', title: 'Licensing Attorney', name: 'Covenant', agent: 'franchise-attorney', tier: 'professional', avatar: '📜', status: 'active', reportsTo: 'legal-gc', desc: 'Software License Agreements, white-label terms, SaaS licensing, usage rights and restrictions' },
      { id: 'legal-contracts', title: 'Contract Specialist', name: 'Clause', agent: 'contract-specialist', tier: 'professional', avatar: '📝', status: 'active', reportsTo: 'legal-gc', desc: 'Contract generation, review, lifecycle management, template library' },
    ]
  },
];

// Additional agents to inject into community departments
const ADDITIONAL_AGENTS = {
  engineering: [
    { id: 'eng-browser', title: 'Automation Engineer', name: 'Phantom', agent: 'browser-agent', tier: 'professional', avatar: '🌐', status: 'active', reportsTo: 'eng-lead', desc: 'Browser automation, web scraping, headless operations' },
  ],
  'marketing': [
    { id: 'mkt-social', title: 'Social Media Manager', name: 'Pulse', agent: 'social-intel', tier: 'scout', avatar: '📱', status: 'active', reportsTo: 'mkt-lead', desc: 'Social monitoring, sentiment analysis, trend detection' },
    { id: 'sales-lead', title: 'Sales Director', name: 'Catalyst', agent: 'lead-gen', tier: 'professional', avatar: '🤝', status: 'active', reportsTo: 'coo', desc: 'Lead generation, prospect enrichment, scoring, outreach sequences' },
  ],
  product: [
    { id: 'prod-predict', title: 'Data Scientist', name: 'Forecast', agent: 'predictions', tier: 'professional', avatar: '📉', status: 'active', reportsTo: 'prod-lead', desc: 'Predictive analytics, forecasts, confidence scoring, trend analysis' },
    { id: 'prod-knowledge', title: 'Knowledge Manager', name: 'Archive', agent: 'knowledge-graph', tier: 'professional', avatar: '🧩', status: 'active', reportsTo: 'prod-lead', desc: 'Knowledge ingestion, semantic linking, graph visualization' },
  ],
  operations: [
    { id: 'ops-cron', title: 'Scheduler', name: 'Tempo', agent: 'hermes-cron', tier: 'persistent', avatar: '⏰', status: 'active', reportsTo: 'ops-hermes', desc: 'CRON job management, routine scheduling, periodic execution' },
    { id: 'ops-gate', title: 'Compliance Officer', name: 'Gatekeeper', agent: 'hermes-approval', tier: 'persistent', avatar: '✅', status: 'active', reportsTo: 'ops-hermes', desc: 'Approval gates, risk assessment, compliance enforcement' },
    { id: 'ops-batch', title: 'Batch Processor', name: 'Conveyor', agent: 'deepseek-worker', tier: 'economy', avatar: '📦', status: 'active', reportsTo: 'coo', desc: 'Bulk content generation, economy-tier batch processing' },
    { id: 'ops-grok', title: 'Intelligence Analyst', name: 'Hawkeye', agent: 'grok-realtime', tier: 'realtime', avatar: '🦅', status: 'active', reportsTo: 'ceo', desc: 'Real-time web search, trending topics, live intelligence' },
  ],
};

module.exports = { COMMERCIAL_DEPARTMENTS, ADDITIONAL_AGENTS };
