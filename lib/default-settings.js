// lib/default-settings.js — single source of truth for freshly provisioned tenant settings.
// Returns a new object each call: callers mutate the result (industry templates, etc.).

function defaultTenantSettings() {
  return {
    ai: { anthropic_api_key: '', openai_api_key: '', deepseek_api_key: '', xai_api_key: '', gemini_api_key: '', perplexity_api_key: '', firecrawl_api_key: '', tavily_api_key: '', apify_api_token: '', manus_api_key: '', livekit_api_key: '', livekit_api_secret: '', livekit_url: '', deepgram_api_key: '', cartesia_api_key: '' },
    mcp: { hermes_url: 'http://127.0.0.1:8420', hermes_enabled: false },
    notifications: { telegram_bot_token: '', telegram_chat_id: '', slack_webhook_url: '' },
    automation: { n8n_webhook_base: '', n8n_api_key: '', team_webhook_url: '' },
    stripe: { secret_key: '', webhook_secret: '', business_price_id: '', enterprise_price_id: '', enterprise_renewal_price_id: '' },
    seo: { dataforseo_login: '', dataforseo_password: '', default_location: 'United States', default_language: 'en' },
    general: { demo_mode: true, cors_origin: '*', api_token: '' },
  };
}

module.exports = { defaultTenantSettings };
