import type { MarketplaceAgent, MarketplaceService } from "./marketplace.js";

export type GoalDomain =
  | "career_document"
  | "crypto_market"
  | "finance_market"
  | "security"
  | "creative"
  | "website_brand"
  | "social_content"
  | "travel"
  | "sports_prediction"
  | "health"
  | "weather"
  | "general";

function serviceText(agent: MarketplaceAgent, service: MarketplaceService): string {
  return `${agent.name} ${agent.description} ${agent.category} ${service.serviceName} ${service.description ?? ""} ${service.endpoint}`.toLowerCase();
}


function exactServiceText(service: MarketplaceService): string {
  return `${service.serviceName} ${service.description ?? ""} ${service.endpoint}`.toLowerCase();
}
export function detectGoalDomain(goal: string): GoalDomain {
  const g = goal.toLowerCase();
  if (/\b(cv|resume|curriculum vitae|cover letter|job application|jobs?|hiring|career|linkedin|personal statement)\b/.test(g)) return "career_document";
  if (/(?:\$[a-z][a-z0-9]{1,11}\b|\b(?:bitcoin|ethereum|solana|hyperliquid|hype|btc|eth|sol|usdt|usdc|token|crypto|coin|defi|dex|onchain|on-chain|wallet|holders?|rug|honeypot|market brief)\b)/i.test(goal)) return "crypto_market";
  if (/\b(stock|stocks|equity|equities|shares?|portfolio|allocation|macro|commodit(?:y|ies)|index|indices)\b/.test(g)) return "finance_market";
  if (/\b(build|create|design|make|launch)\b.*\b(website|site|landing page|web page|web app|homepage)\b|\b(website|site|landing page|web page|web app|homepage)\b.*\b(brand|business|skincare|product|store)\b/.test(g)) return "website_brand";
  if (/\b(security|audit|scan|risk|verify|safe|vulnerability|exploit|url|payload|contract)\b/.test(g)) return "security";
  if (/\b(logo|brand|image|illustration|avatar|sticker|art|design|manga|music|song|video)\b/.test(g)) return "creative";
  if (/\b(tweet|thread|youtube|shorts|post|viral|caption|content strategy|social)\b/.test(g)) return "social_content";
  if (/\b(travel|trip|flight|hotel|itinerary|destination|tour|visit|things to do)\b/.test(g)) return "travel";
  if (/\b(sports?|football|soccer|match|team|league|cup|odds|predict|prediction|forecast|betting|who will win)\b/.test(g)) return "sports_prediction";
  if (/\b(health|diet|fitness|nutrition|calorie|workout|food|wellness|medical)\b/.test(g)) return "health";
  if (/\b(weather|forecast|temperature|rain|wind|humidity)\b/.test(g)) return "weather";
  return "general";
}

export function serviceMatchesGoalDomain(goal: string, agent: MarketplaceAgent, service: MarketplaceService): boolean {
  const domain = detectGoalDomain(goal);
  const goalText = goal.toLowerCase();
  const text = serviceText(agent, service);
  const exactText = exactServiceText(service);
  const has = (re: RegExp) => re.test(text);
  const exactHas = (re: RegExp) => re.test(exactText);

  const financeOrCrypto = /\b(crypto|token|coin|onchain|on-chain|blockchain|wallet|defi|dex|swap|bridge|x layer|xlayer|trading|trade|traders|market|markets|market cap|price|price feed|chart|charts|tradingview|rsi|macd|ohlcv|perp|futures|funding|liquidity|holders|honeypot|rug|kol sentiment|whale|polymarket|prediction market|stock|equity|shares?|portfolio|allocation)\b/;
  const socialOnly = /\b(tweet|thread|youtube|shorts|viral|caption|kol studio|launch proof|campaign|creator)\b/;
  const actionOnly = /\b(launch|mint|deploy|swap|buy|sell|bridge|stake|withdraw|transfer)\b/;
  const credentialGateway = /\b(bring-your-own-key|api_key|credentials|own provider api keys)\b/;
  const generalTaskService = /\b(plain-language request|managed agent task|task execution|research assistant|web search|summaries|chat completion)\b/;
  const buildWebsiteGoal = /\b(build|create|design|make|launch)\b.*\b(website|site|landing page|web page|web app|homepage)\b|\b(website|site|landing page|web page|web app|homepage)\b.*\b(brand|business|skincare|product|store)\b/.test(goalText);
  const websiteResearchService = /\b(aeo|seo|audit|risk|scrape|extract|search|sitemap|crawler|crawlers|llms|url risk|structured feed|links)\b/;
  const websiteExecutionService = /\b(landing page html|landing page|web design|web design & development|deploy-ready web pages|website builder|complete launch kit|design token|palette|styling apps and sites|managed agent task|plain-language request|task execution)\b/;
  const websiteBuildService = /\b(landing page html|landing page|web design|web design & development|deploy-ready web pages|website builder|homepage|web page|web app|complete launch kit|design token|palette|styling apps and sites|managed agent task|plain-language request|task execution)\b/;

  if (domain === "general") return !exactHas(credentialGateway) && exactHas(generalTaskService);

  switch (domain) {
    case "career_document":
      return !has(financeOrCrypto) && !has(socialOnly) && !has(actionOnly) && !exactHas(credentialGateway) &&
        exactHas(/\b(cv|resume|curriculum vitae|cover letter|job application|career|linkedin|writing|writer|copywriting|plain-language request|managed agent task|task execution|research assistant|web search|summaries|chat completion)\b/);
    case "crypto_market":
      return has(/\b(crypto|token|coin|onchain|on-chain|blockchain|wallet|defi|dex|x layer|xlayer|market|price|price feed|chart|perp|futures|funding|liquidity|holders|honeypot|rug|kol|whale|sentiment)\b/) && !has(/\b(stock|equity|tokenized stock)\b/);
    case "finance_market":
      return has(/\b(stock|equity|shares?|portfolio|allocation|macro|indices|commodities|market data|research note|backtest)\b/);
    case "security":
      return has(/\b(security|audit|scan|risk|verify|guardrail|preflight|payload|vulnerability|contract auditor|url drain)\b/);
    case "creative":
      return has(/\b(logo|brand|image|illustration|avatar|sticker|art|design|manga|music|song|video|generate)\b/);
    case "website_brand":
      if (buildWebsiteGoal && exactHas(websiteResearchService) && !exactHas(websiteExecutionService)) return false;
      return !has(financeOrCrypto) && !exactHas(credentialGateway) && exactHas(websiteBuildService);
    case "social_content":
      return has(/\b(tweet|thread|youtube|shorts|post|viral|caption|content|creator|script)\b/);
    case "travel":
      return has(/\b(travel|trip planner|plan-trip|flight|hotel|itinerary|tourism|visa|entry requirements|things to do)\b/);
    case "sports_prediction":
      return has(/\b(sports?|football|soccer|match|team|league|cup|odds|predict|prediction|forecast|betting|polymarket)\b/);
    case "health":
      return has(/\b(health|diet|fitness|nutrition|calorie|workout|food|wellness|medical)\b/);
    case "weather":
      return has(/\b(weather|forecast|temperature|rain|wind|humidity)\b/);
  }
}

export function domainMismatchReason(goal: string): string {
  const domain = detectGoalDomain(goal).replace(/_/g, " ");
  return `No compatible ${domain} agent found on the marketplace for this goal. Bind refused to hire off-domain agents.`;
}