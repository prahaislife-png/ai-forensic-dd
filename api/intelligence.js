const RDAP_DOMAIN_API = "https://rdap.org/domain/";
const DUCKDUCKGO_INSTANT_API = "https://api.duckduckgo.com/";
const OPENCORPORATES_COMPANY_SEARCH_API = "https://api.opencorporates.com/v0.4/companies/search";
const OPENCORPORATES_COMPANY_DETAILS_API = "https://api.opencorporates.com/v0.4/companies";
const OPENCORPORATES_OFFICERS_SEARCH_API = "https://api.opencorporates.com/v0.4/officers/search";
const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const WIKIPEDIA_SEARCH_API = "https://en.wikipedia.org/w/api.php";

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace("www.", "").toLowerCase();
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

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.text();
}

function normalizeDomainCandidate(website) {
  if (!website) return null;
  const trimmed = String(website).trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return extractDomain(withProtocol);
}

function cleanString(value) {
  if (!value) return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized || null;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map(cleanString).filter(Boolean)));
}

function collectUrlsFromDuckResult(data) {
  const urls = [];

  if (data?.AbstractURL) urls.push(data.AbstractURL);

  const collectRelated = (items = []) => {
    for (const item of items) {
      if (item?.FirstURL) {
        urls.push(item.FirstURL);
      }
      if (Array.isArray(item?.Topics)) {
        collectRelated(item.Topics);
      }
    }
  };

  if (Array.isArray(data?.RelatedTopics)) {
    collectRelated(data.RelatedTopics);
  }

  if (Array.isArray(data?.Results)) {
    for (const item of data.Results) {
      if (item?.FirstURL) urls.push(item.FirstURL);
    }
  }

  return uniqueStrings(urls);
}

function categorizeUrl(url) {
  const domain = extractDomain(url || "");
  if (!domain) return "other";
  if (domain.includes("linkedin.com")) return "linkedin";
  if (domain.includes("opencorporates.com")) return "registry";
  if (domain.includes("bloomberg.com")) return "media";
  if (domain.includes("crunchbase.com")) return "business_directory";
  if (domain.includes("wikipedia.org")) return "knowledge_graph";
  if (domain.includes("gov") || domain.includes("gouv") || domain.includes(".gc.")) return "government_registry";
  return "other";
}

async function runDuckDuckGoQuery(query) {
  try {
    const params = new URLSearchParams({ q: query, format: "json", no_redirect: "1", no_html: "1" });
    const data = await fetchJson(`${DUCKDUCKGO_INSTANT_API}?${params.toString()}`);
    return collectUrlsFromDuckResult(data);
  } catch {
    return [];
  }
}

async function getGlobalSearchDiscovery(companyName) {
  if (!companyName) {
    return {
      discoveredUrls: [],
      categorizedUrls: {
        linkedin: [],
        registry: [],
        media: [],
        business_directory: [],
        knowledge_graph: [],
        government_registry: [],
        other: []
      }
    };
  }

  const queries = [
    companyName,
    `site:linkedin.com ${companyName}`,
    `site:opencorporates.com ${companyName}`,
    `site:bloomberg.com ${companyName}`,
    `site:crunchbase.com ${companyName}`
  ];

  const results = await Promise.all(queries.map((query) => runDuckDuckGoQuery(query)));
  const discoveredUrls = uniqueStrings(results.flat());

  const categorizedUrls = {
    linkedin: [],
    registry: [],
    media: [],
    business_directory: [],
    knowledge_graph: [],
    government_registry: [],
    other: []
  };

  for (const url of discoveredUrls) {
    const bucket = categorizeUrl(url);
    categorizedUrls[bucket].push(url);
  }

  return {
    discoveredUrls,
    categorizedUrls
  };
}

function normalizeAddress(value) {
  return cleanString(value)?.toLowerCase() || null;
}

function extractAddressCandidates(text) {
  if (!text) return [];

  const compact = text.replace(/\s+/g, " ");
  const patterns = [
    /\b\d{1,6}\s+[A-Za-z0-9.,\-\s]{3,80}\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Suite|Ste|Floor|Fl)\b[^.\n]{0,120}/gi,
    /\b[Pp]\.?\s?[Oo]\.?(?:\s?[Bb]ox)?\s*\d+[A-Za-z0-9\-\s,]{0,80}/g,
    /\b[A-Za-z\-\s]+,\s*[A-Za-z\-\s]+,\s*[A-Z]{2}\s*\d{4,10}\b/g,
    /\b[A-Za-z\-\s]+,\s*[A-Za-z\-\s]+\s*\d{4,10},\s*[A-Za-z\-\s]+\b/g
  ];

  const matches = [];
  for (const regex of patterns) {
    const found = compact.match(regex);
    if (found) matches.push(...found);
  }

  return uniqueStrings(matches.map((entry) => entry.replace(/\s+/g, " ").trim()));
}

function pickMostFrequentAddress(addresses = []) {
  const counts = new Map();
  const displayMap = new Map();

  for (const address of addresses) {
    const clean = cleanString(address);
    const key = normalizeAddress(clean);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!displayMap.has(key)) displayMap.set(key, clean);
  }

  if (!counts.size) {
    return {
      verifiedAddress: null,
      alternativeAddresses: []
    };
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const verifiedAddress = displayMap.get(sorted[0][0]) || null;
  const alternativeAddresses = sorted.slice(1).map(([key]) => displayMap.get(key)).filter(Boolean);

  return {
    verifiedAddress,
    alternativeAddresses
  };
}

async function getDomainIntelligence(website) {
  const domain = normalizeDomainCandidate(website);

  if (!domain) {
    return {
      domain: null,
      registrar: null,
      creationDate: null,
      nameservers: []
    };
  }

  try {
    const rdapData = await fetchJson(`${RDAP_DOMAIN_API}${encodeURIComponent(domain)}`);

    const creationDate =
      rdapData?.events?.find((event) => event?.eventAction === "registration")?.eventDate || null;

    const nameservers = Array.isArray(rdapData?.nameservers)
      ? rdapData.nameservers.map((ns) => ns?.ldhName).filter(Boolean)
      : [];

    const registrarEntity = Array.isArray(rdapData?.entities)
      ? rdapData.entities.find(
          (entity) => Array.isArray(entity?.roles) && entity.roles.some((role) => /registrar/i.test(role))
        )
      : null;

    const registrar =
      registrarEntity?.vcardArray?.[1]?.find((item) => item?.[0] === "fn")?.[3] || registrarEntity?.handle || null;

    return {
      domain,
      registrar,
      creationDate,
      nameservers
    };
  } catch {
    return {
      domain,
      registrar: null,
      creationDate: null,
      nameservers: []
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
      companyStatus: null,
      registeredAddress: null,
      officers: []
    };
  }

  try {
    const params = new URLSearchParams({ q: companyName, per_page: "5" });
    const searchData = await fetchJson(`${OPENCORPORATES_COMPANY_SEARCH_API}?${params.toString()}`);
    const candidates = Array.isArray(searchData?.results?.companies) ? searchData.results.companies : [];
    const selected = candidates[0]?.company;

    if (!selected) {
      return {
        companyName: null,
        jurisdiction: null,
        companyNumber: null,
        incorporationDate: null,
        companyStatus: null,
        registeredAddress: null,
        officers: []
      };
    }

    const jurisdiction = selected?.jurisdiction_code || null;
    const companyNumber = selected?.company_number || null;

    let registeredAddress = cleanString(selected?.registered_address_in_full || selected?.registered_address);
    let officers = [];

    if (jurisdiction && companyNumber) {
      try {
        const detailsUrl = `${OPENCORPORATES_COMPANY_DETAILS_API}/${encodeURIComponent(
          jurisdiction
        )}/${encodeURIComponent(companyNumber)}`;
        const detailsData = await fetchJson(detailsUrl);
        const detailedCompany = detailsData?.results?.company;

        registeredAddress =
          cleanString(
            detailedCompany?.registered_address_in_full ||
              detailedCompany?.registered_address?.street_address ||
              detailedCompany?.registered_address
          ) || registeredAddress;

        officers = Array.isArray(detailedCompany?.officers)
          ? detailedCompany.officers
              .map((entry) => ({
                name: cleanString(entry?.officer?.name),
                position: cleanString(entry?.officer?.position)
              }))
              .filter((entry) => entry.name)
          : [];
      } catch {
        officers = [];
      }
    }

    return {
      companyName: cleanString(selected?.name),
      jurisdiction,
      companyNumber,
      incorporationDate: selected?.incorporation_date || null,
      companyStatus: cleanString(selected?.current_status),
      registeredAddress,
      officers
    };
  } catch {
    return {
      companyName: null,
      jurisdiction: null,
      companyNumber: null,
      incorporationDate: null,
      companyStatus: null,
      registeredAddress: null,
      officers: []
    };
  }
}

function extractCompanyDescription(html = "") {
  if (!html) return null;

  const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (metaMatch?.[1]) return cleanString(metaMatch[1]);

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  return cleanString(titleMatch?.[1]);
}

function extractEmails(text = "") {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return uniqueStrings(matches);
}

function extractPhones(text = "") {
  const matches = text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{2,4}[\s.-]?\d{3,4}/g) || [];
  return uniqueStrings(matches);
}

async function fetchPageWithFallback(urls = []) {
  for (const url of urls) {
    try {
      const html = await fetchText(url);
      return { url, html };
    } catch {
      // continue
    }
  }
  return { url: null, html: null };
}

async function getWebsiteAnalysis(website) {
  const domain = normalizeDomainCandidate(website);

  if (!domain) {
    return {
      websiteExists: false,
      httpsEnabled: false,
      companyDescription: null,
      address: null,
      phone: null,
      email: null,
      pagesChecked: []
    };
  }

  const baseHttps = `https://${domain}`;
  const baseHttp = `http://${domain}`;

  const homepage = await fetchPageWithFallback([baseHttps, baseHttp]);
  const pages = ["/about", "/contact"];
  const pageResults = [];
  let aggregateText = homepage.html || "";

  for (const path of pages) {
    const pageData = await fetchPageWithFallback([`${baseHttps}${path}`, `${baseHttp}${path}`]);
    pageResults.push({ path, url: pageData.url, found: Boolean(pageData.html) });
    if (pageData.html) aggregateText += `\n${pageData.html}`;
  }

  const descriptions = [extractCompanyDescription(homepage.html), extractCompanyDescription(aggregateText)].filter(Boolean);
  const addresses = extractAddressCandidates(aggregateText);
  const phones = extractPhones(aggregateText);
  const emails = extractEmails(aggregateText);

  return {
    websiteExists: Boolean(homepage.html),
    httpsEnabled: homepage.url?.startsWith("https://") || false,
    companyDescription: descriptions[0] || null,
    address: addresses[0] || null,
    phone: phones[0] || null,
    email: emails[0] || null,
    pagesChecked: [
      { path: "/", url: homepage.url, found: Boolean(homepage.html) },
      ...pageResults
    ],
    extractedAddresses: addresses,
    extractedPhones: phones,
    extractedEmails: emails
  };
}

async function getAdverseMedia(companyName) {
  if (!companyName) {
    return {
      articleCount: 0,
      adverseHits: 0,
      sources: []
    };
  }

  const keywords = ["fraud", "corruption", "lawsuit", "criminal investigation", "bribery", "sanctions"];
  const sources = new Set();
  let articleCount = 0;
  let adverseHits = 0;

  for (const keyword of keywords) {
    try {
      const query = `"${companyName}" AND "${keyword}"`;
      const params = new URLSearchParams({
        query,
        mode: "ArtList",
        format: "json",
        maxrecords: "10",
        sort: "HybridRel"
      });

      const data = await fetchJson(`${GDELT_DOC_API}?${params.toString()}`);
      const articles = Array.isArray(data?.articles) ? data.articles : [];

      articleCount += articles.length;
      if (articles.length > 0) adverseHits += 1;

      for (const article of articles) {
        if (article?.source) sources.add(article.source);
        else if (article?.domain) sources.add(article.domain);
      }
    } catch {
      // Continue processing other keywords.
    }
  }

  return {
    articleCount,
    adverseHits,
    sources: Array.from(sources)
  };
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

async function getCorporateNetwork(corporateRegistry) {
  const officers = Array.isArray(corporateRegistry?.officers) ? corporateRegistry.officers : [];
  const directors = officers.filter((entry) => /director/i.test(entry?.position || ""));

  const enrichedDirectors = [];

  for (const director of directors) {
    const directorName = cleanString(director?.name);
    if (!directorName) continue;

    let otherCompanies = [];

    try {
      const params = new URLSearchParams({ q: directorName, per_page: "5" });
      const data = await fetchJson(`${OPENCORPORATES_OFFICERS_SEARCH_API}?${params.toString()}`);
      const results = Array.isArray(data?.results?.officers) ? data.results.officers : [];

      otherCompanies = uniqueStrings(
        results
          .map((row) => row?.officer?.company?.name)
          .filter((name) => name && name !== corporateRegistry?.companyName)
      );
    } catch {
      otherCompanies = [];
    }

    enrichedDirectors.push({
      name: directorName,
      position: cleanString(director?.position),
      otherCompanies
    });
  }

  return {
    directors: enrichedDirectors
  };
}

function buildOwnership(corporateRegistry) {
  const officers = Array.isArray(corporateRegistry?.officers) ? corporateRegistry.officers : [];
  const directors = officers.filter((entry) => /director/i.test(entry?.position || ""));

  return {
    officers,
    directors
  };
}

function buildAddressVerification(corporateRegistry, websiteAnalysis, searchDiscovery) {
  const sourceAddresses = [
    corporateRegistry?.registeredAddress,
    websiteAnalysis?.address,
    ...(Array.isArray(websiteAnalysis?.extractedAddresses) ? websiteAnalysis.extractedAddresses : [])
  ];

  const directoryAddressHints = [];
  const candidateUrls = [
    ...(searchDiscovery?.categorizedUrls?.business_directory || []),
    ...(searchDiscovery?.categorizedUrls?.government_registry || []),
    ...(searchDiscovery?.categorizedUrls?.registry || [])
  ];

  for (const url of candidateUrls) {
    directoryAddressHints.push(...extractAddressCandidates(url));
  }

  const consolidated = uniqueStrings([...sourceAddresses, ...directoryAddressHints]);
  return pickMostFrequentAddress(consolidated);
}

async function collectAdditionalIntelligence(companyName, website) {
  const [searchDiscovery, corporateRegistry, websiteAnalysis, domainIntelligence, adverseMedia, publicKnowledgeGraph] =
    await Promise.all([
      getGlobalSearchDiscovery(companyName),
      getCorporateRegistry(companyName),
      getWebsiteAnalysis(website),
      getDomainIntelligence(website),
      getAdverseMedia(companyName),
      getPublicKnowledgeGraph(companyName)
    ]);

  const corporateNetwork = await getCorporateNetwork(corporateRegistry);
  const ownership = buildOwnership(corporateRegistry);
  const addressVerification = buildAddressVerification(corporateRegistry, websiteAnalysis, searchDiscovery);

  const intelligence = {
    domainIntelligence,
    corporateRegistry,
    ownership,
    addressVerification,
    websiteAnalysis: {
      websiteExists: websiteAnalysis.websiteExists,
      httpsEnabled: websiteAnalysis.httpsEnabled,
      companyDescription: websiteAnalysis.companyDescription,
      address: websiteAnalysis.address,
      phone: websiteAnalysis.phone,
      email: websiteAnalysis.email,
      pagesChecked: websiteAnalysis.pagesChecked
    },
    adverseMedia,
    publicKnowledgeGraph,
    corporateNetwork,
    sourceDiscovery: searchDiscovery
  };

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
  getCorporateRegistry,
  getWebsiteAnalysis,
  getAdverseMedia,
  getPublicKnowledgeGraph,
  getCorporateNetwork,
  getGlobalSearchDiscovery
};
