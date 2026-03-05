const RDAP_DOMAIN_API = "https://rdap.org/domain/";
const OPENCORPORATES_COMPANY_SEARCH_API = "https://api.opencorporates.com/v0.4/companies/search";
const OPENCORPORATES_COMPANY_DETAILS_API = "https://api.opencorporates.com/v0.4/companies";
const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const WIKIPEDIA_SEARCH_API = "https://en.wikipedia.org/w/api.php";

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "").toLowerCase();
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function extractRegistrarName(entities = []) {
  const registrarEntity = entities.find(
    (entity) => Array.isArray(entity?.roles) && entity.roles.some((role) => /registrar/i.test(role))
  );

  if (!registrarEntity) return null;

  const fnField = Array.isArray(registrarEntity?.vcardArray?.[1])
    ? registrarEntity.vcardArray[1].find((item) => item?.[0] === "fn")
    : null;

  return fnField?.[3] || registrarEntity.handle || null;
}

function normalizeDomainCandidate(website) {
  if (!website) return null;
  const trimmed = String(website).trim();
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return extractDomain(withProtocol);
}

async function getDomainIntelligence(website) {
  const domain = normalizeDomainCandidate(website);

  if (!domain) {
    return {
      domain: null,
      registrar: null,
      createdDate: null,
      nameservers: [],
      country: null
    };
  }

  try {
    const rdapData = await fetchJson(`${RDAP_DOMAIN_API}${encodeURIComponent(domain)}`);

    const createdDate =
      rdapData?.events?.find((event) => event?.eventAction === "registration")?.eventDate || null;

    const nameservers = Array.isArray(rdapData?.nameservers)
      ? rdapData.nameservers.map((ns) => ns?.ldhName).filter(Boolean)
      : [];

    const country =
      rdapData?.entities?.find((entity) => entity?.country)?.country || rdapData?.country || null;

    return {
      domain,
      registrar: extractRegistrarName(Array.isArray(rdapData?.entities) ? rdapData.entities : []) || null,
      createdDate,
      nameservers,
      country
    };
  } catch {
    return {
      domain,
      registrar: null,
      createdDate: null,
      nameservers: [],
      country: null
    };
  }
}

async function getWebsiteSecurity(domain) {
  if (!domain) {
    return {
      websiteAccessible: false,
      httpsEnabled: false
    };
  }

  try {
    const response = await fetch(`https://${domain}`, { redirect: "follow" });
    return {
      websiteAccessible: response.ok,
      httpsEnabled: true
    };
  } catch {
    return {
      websiteAccessible: false,
      httpsEnabled: false
    };
  }
}

function detectTechnologies(html = "", headers = {}) {
  const lowerHtml = html.toLowerCase();
  const headerValues = Object.values(headers).join(" ").toLowerCase();
  const detected = [];

  const patterns = [
    { name: "WordPress", regex: /wp-content|wordpress/i },
    { name: "Shopify", regex: /cdn\.shopify|shopify/i },
    { name: "React", regex: /react|__next|data-reactroot/i },
    { name: "Angular", regex: /ng-app|angular/i },
    { name: "Google Analytics", regex: /gtag\(|google-analytics|googletagmanager/i },
    { name: "Cloudflare", regex: /cloudflare|cf-ray/i }
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(lowerHtml) || pattern.regex.test(headerValues)) {
      detected.push(pattern.name);
    }
  }

  return Array.from(new Set(detected));
}

async function getTechnologyProfile(domain) {
  if (!domain) {
    return {
      detectedTechnologies: []
    };
  }

  try {
    const response = await fetch(`https://${domain}`, { redirect: "follow" });
    if (!response.ok) {
      return { detectedTechnologies: [] };
    }

    const html = await response.text();
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      detectedTechnologies: detectTechnologies(html, headers)
    };
  } catch {
    return {
      detectedTechnologies: []
    };
  }
}

async function getCorporateRegistry(companyName) {
  if (!companyName) {
    return {
      companyName: null,
      jurisdiction: null,
      companyNumber: null,
      incorporationDate: null,
      companyStatus: null
    };
  }

  try {
    const params = new URLSearchParams({ q: companyName, per_page: "1" });
    const data = await fetchJson(`${OPENCORPORATES_COMPANY_SEARCH_API}?${params.toString()}`);
    const company = data?.results?.companies?.[0]?.company;

    if (!company) {
      return {
        companyName: null,
        jurisdiction: null,
        companyNumber: null,
        incorporationDate: null,
        companyStatus: null
      };
    }

    return {
      companyName: company?.name || null,
      jurisdiction: company?.jurisdiction_code || null,
      companyNumber: company?.company_number || null,
      incorporationDate: company?.incorporation_date || null,
      companyStatus: company?.current_status || null
    };
  } catch {
    return {
      companyName: null,
      jurisdiction: null,
      companyNumber: null,
      incorporationDate: null,
      companyStatus: null
    };
  }
}

async function getCorporateNetwork(corporateRegistry) {
  const jurisdiction = corporateRegistry?.jurisdiction;
  const companyNumber = corporateRegistry?.companyNumber;

  if (!jurisdiction || !companyNumber) {
    return {
      directors: [],
      officers: []
    };
  }

  try {
    const detailsUrl = `${OPENCORPORATES_COMPANY_DETAILS_API}/${encodeURIComponent(
      jurisdiction
    )}/${encodeURIComponent(companyNumber)}`;

    const data = await fetchJson(detailsUrl);
    const officers = Array.isArray(data?.results?.company?.officers)
      ? data.results.company.officers
      : [];

    const normalizedOfficers = officers
      .map((entry) => ({
        name: entry?.officer?.name || null,
        position: entry?.officer?.position || null
      }))
      .filter((entry) => entry.name || entry.position);

    const directors = normalizedOfficers
      .filter((entry) => /director/i.test(entry.position || ""))
      .map((entry) => entry.name)
      .filter(Boolean);

    return {
      directors: Array.from(new Set(directors)),
      officers: normalizedOfficers
    };
  } catch {
    return {
      directors: [],
      officers: []
    };
  }
}

async function getAdverseMedia(companyName) {
  if (!companyName) {
    return {
      articleCount: 0,
      adverseHits: 0,
      sources: []
    };
  }

  try {
    const keywords = [
      "fraud",
      "corruption",
      "bribery",
      "money laundering",
      "lawsuit",
      "criminal investigation",
      "scam"
    ];

    const query = `"${companyName}" AND (${keywords.join(" OR ")})`;
    const params = new URLSearchParams({
      query,
      mode: "ArtList",
      format: "json",
      maxrecords: "20",
      sort: "HybridRel"
    });

    const data = await fetchJson(`${GDELT_DOC_API}?${params.toString()}`);
    const articles = Array.isArray(data?.articles) ? data.articles : [];

    const sources = Array.from(
      new Set(articles.map((article) => article?.source || article?.domain).filter(Boolean))
    ).slice(0, 10);

    return {
      articleCount: articles.length,
      adverseHits: articles.length,
      sources
    };
  } catch {
    return {
      articleCount: 0,
      adverseHits: 0,
      sources: []
    };
  }
}

async function getPublicKnowledgeGraph(companyName) {
  if (!companyName) {
    return {
      wikipediaFound: false,
      pageTitle: null,
      pageUrl: null
    };
  }

  try {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: companyName,
      format: "json"
    });

    const data = await fetchJson(`${WIKIPEDIA_SEARCH_API}?${params.toString()}`);
    const topResult = data?.query?.search?.[0];

    if (!topResult?.title) {
      return {
        wikipediaFound: false,
        pageTitle: null,
        pageUrl: null
      };
    }

    const pageTitle = topResult.title;

    return {
      wikipediaFound: true,
      pageTitle,
      pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/\s+/g, "_"))}`
    };
  } catch {
    return {
      wikipediaFound: false,
      pageTitle: null,
      pageUrl: null
    };
  }
}

async function collectAdditionalIntelligence(companyName, website) {
  const domain = normalizeDomainCandidate(website);

  const [domainIntelligence, websiteSecurity, technologyProfile, corporateRegistry, adverseMedia, publicKnowledgeGraph] =
    await Promise.all([
      getDomainIntelligence(website),
      getWebsiteSecurity(domain),
      getTechnologyProfile(domain),
      getCorporateRegistry(companyName),
      getAdverseMedia(companyName),
      getPublicKnowledgeGraph(companyName)
    ]);

  const corporateNetwork = await getCorporateNetwork(corporateRegistry);

  const intelligence = {
    domainIntelligence,
    websiteSecurity,
    technologyProfile,
    corporateRegistry,
    corporateNetwork,
    adverseMedia,
    publicKnowledgeGraph
  };

  // Backward-compatible aliases for existing report consumers.
  intelligence.media = adverseMedia;
  intelligence.domain = domainIntelligence;
  intelligence.knowledge = publicKnowledgeGraph;
  intelligence.network = corporateNetwork;

  return intelligence;
}

module.exports = {
  extractDomain,
  collectAdditionalIntelligence,
  getDomainIntelligence,
  getWebsiteSecurity,
  getTechnologyProfile,
  getCorporateRegistry,
  getCorporateNetwork,
  getAdverseMedia,
  getPublicKnowledgeGraph
};