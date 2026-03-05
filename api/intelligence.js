const DUCKDUCKGO_INSTANT_API = "https://api.duckduckgo.com/";
const OPENCORPORATES_COMPANY_SEARCH_API = "https://api.opencorporates.com/v0.4/companies/search";
const OPENCORPORATES_COMPANY_DETAILS_API = "https://api.opencorporates.com/v0.4/companies";
const OPENCORPORATES_OFFICERS_SEARCH_API = "https://api.opencorporates.com/v0.4/officers/search";
const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const WIKIPEDIA_SEARCH_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_SEARCH_API = "https://www.wikidata.org/w/api.php";
const OPENSANCTIONS_MATCH_API = "https://api.opensanctions.org/match/default";

const SANCTIONS_DATASETS = [
  { key: "opensanctions", label: "OpenSanctions" },
  { key: "ofac", label: "OFAC SDN" },
  { key: "eu", label: "EU Consolidated Sanctions List" },
  { key: "uk", label: "UK HMT Sanctions List" },
  { key: "un", label: "UN Security Council Sanctions" },
  { key: "interpol", label: "Interpol Notices" }
];

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace("www.", "").toLowerCase();
  } catch {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    },
    ...options
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

function cleanString(value) {
  if (!value) return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized || null;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map(cleanString).filter(Boolean)));
}

function toNoDataFound() {
  return { status: "no data found" };
}

function tokenize(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function similarityScore(a = "", b = "") {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }

  return (2 * intersection) / (aTokens.size + bTokens.size);
}

function classifySimilarity(similarity) {
  if (similarity < 0.75) {
    return { match: false, reason: "Low confidence similarity" };
  }
  if (similarity >= 0.85) {
    return { match: true, reason: "Confirmed similarity threshold met" };
  }
  return { match: false, reason: "Possible name similarity — no confirmed relationship" };
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
  if (domain.includes("wikipedia.org") || domain.includes("wikidata.org")) return "knowledge_graph";
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
      categorizedUrls: { linkedin: [], registry: [], knowledge_graph: [], government_registry: [], other: [] }
    };
  }

  const queries = [companyName, `site:opencorporates.com ${companyName}`, `site:wikipedia.org ${companyName}`];
  const results = await Promise.all(queries.map((query) => runDuckDuckGoQuery(query)));
  const discoveredUrls = uniqueStrings(results.flat());

  const categorizedUrls = { linkedin: [], registry: [], knowledge_graph: [], government_registry: [], other: [] };
  for (const url of discoveredUrls) {
    const bucket = categorizeUrl(url);
    categorizedUrls[bucket].push(url);
  }

  return { discoveredUrls, categorizedUrls };
}

function inferRegistrySource(jurisdiction = "") {
  const code = String(jurisdiction || "").toLowerCase();
  if (code === "us_de" || code.startsWith("us_")) return "OpenCorporates + SEC EDGAR + State Business Registries";
  if (["gb", "uk"].includes(code)) return "OpenCorporates + Companies House (UK) + EU Open Data";
  if (code.startsWith("br")) return "OpenCorporates + Brazil Receita Federal registry";
  if (code.startsWith("mx")) return "OpenCorporates + Mexico Public Registry of Commerce";
  if (["fr", "de", "es", "it", "nl", "be", "ie", "pt", "pl", "se", "dk", "fi", "no", "at", "ch"].includes(code)) {
    return "OpenCorporates + EU Open Data";
  }
  return "OpenCorporates";
}

async function searchOfficerCompanies(officerName, currentCompanyName) {
  try {
    const params = new URLSearchParams({ q: officerName, per_page: "10" });
    const data = await fetchJson(`${OPENCORPORATES_OFFICERS_SEARCH_API}?${params.toString()}`);
    const rows = Array.isArray(data?.results?.officers) ? data.results.officers : [];
    return uniqueStrings(
      rows
        .map((row) => row?.officer?.company?.name)
        .filter((name) => name && cleanString(name) !== cleanString(currentCompanyName))
    );
  } catch {
    return [];
  }
}

async function getCorporateRegistry(companyName) {
  if (!companyName) return toNoDataFound();

  try {
    const params = new URLSearchParams({ q: companyName, per_page: "5" });
    const searchData = await fetchJson(`${OPENCORPORATES_COMPANY_SEARCH_API}?${params.toString()}`);
    const candidates = Array.isArray(searchData?.results?.companies) ? searchData.results.companies : [];

    let selected = null;
    for (const candidate of candidates) {
      const company = candidate?.company;
      const similarity = similarityScore(companyName, company?.name || "");
      const cls = classifySimilarity(similarity);
      if (cls.match) {
        selected = { company, similarity };
        break;
      }
    }

    if (!selected?.company) return toNoDataFound();

    const company = selected.company;
    const jurisdiction = cleanString(company?.jurisdiction_code);
    const companyNumber = cleanString(company?.company_number);

    let detailsCompany = null;
    if (jurisdiction && companyNumber) {
      try {
        const detailsUrl = `${OPENCORPORATES_COMPANY_DETAILS_API}/${encodeURIComponent(jurisdiction)}/${encodeURIComponent(companyNumber)}`;
        const detailsData = await fetchJson(detailsUrl);
        detailsCompany = detailsData?.results?.company || null;
      } catch {
        detailsCompany = null;
      }
    }

    const companyNameFound = cleanString(company?.name);
    return {
      companyName: companyNameFound,
      jurisdiction,
      incorporationDate: company?.incorporation_date || null,
      companyStatus: cleanString(company?.current_status),
      registrySource: inferRegistrySource(jurisdiction),
      companyNumber,
      registeredAddress:
        cleanString(
          detailsCompany?.registered_address_in_full ||
            detailsCompany?.registered_address?.street_address ||
            company?.registered_address_in_full ||
            company?.registered_address
        ) || null,
      confidence: selected.similarity
    };
  } catch {
    return toNoDataFound();
  }
}

async function getOwnership(corporateRegistry) {
  if (!corporateRegistry || corporateRegistry.status === "no data found") {
    return { officers: [], directors: [] };
  }

  const jurisdiction = corporateRegistry.jurisdiction;
  const companyNumber = corporateRegistry.companyNumber;
  let officerRows = [];

  if (jurisdiction && companyNumber) {
    try {
      const detailsUrl = `${OPENCORPORATES_COMPANY_DETAILS_API}/${encodeURIComponent(jurisdiction)}/${encodeURIComponent(companyNumber)}`;
      const detailsData = await fetchJson(detailsUrl);
      officerRows = Array.isArray(detailsData?.results?.company?.officers) ? detailsData.results.company.officers : [];
    } catch {
      officerRows = [];
    }
  }

  const officers = officerRows
    .map((row) => ({
      name: cleanString(row?.officer?.name),
      role: cleanString(row?.officer?.position)
    }))
    .filter((entry) => entry.name);

  const directors = [];
  for (const officer of officers) {
    if (!/director|officer/i.test(officer.role || "")) continue;
    const otherCompanies = await searchOfficerCompanies(officer.name, corporateRegistry.companyName);
    directors.push({
      name: officer.name,
      role: officer.role || "Director/Officer",
      otherCompanies
    });
  }

  return { officers, directors };
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

function extractAddressCandidates(text) {
  if (!text) return [];
  const compact = text.replace(/\s+/g, " ");
  const matches = compact.match(/\b\d{1,6}\s+[A-Za-z0-9.,\-\s]{3,120}\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Suite|Ste|Floor|Fl)\b[^.\n]{0,120}/gi) || [];
  return uniqueStrings(matches.map((entry) => entry.replace(/\s+/g, " ").trim()));
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
  const domain = extractDomain(/^https?:\/\//i.test(website || "") ? website : `https://${website || ""}`);
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

  return {
    websiteExists: Boolean(homepage.html),
    httpsEnabled: homepage.url?.startsWith("https://") || false,
    companyDescription: extractCompanyDescription(homepage.html) || extractCompanyDescription(aggregateText),
    address: extractAddressCandidates(aggregateText)[0] || null,
    phone: extractPhones(aggregateText)[0] || null,
    email: extractEmails(aggregateText)[0] || null,
    pagesChecked: [{ path: "/", url: homepage.url, found: Boolean(homepage.html) }, ...pageResults]
  };
}

async function getGoogleNewsArticles(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const xml = await fetchText(url);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);
    return items.map((match) => {
      const item = match[1];
      const headline = cleanString((item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]);
      const source = cleanString(item.match(/<source[^>]*>(.*?)<\/source>/)?.[1]) || "Google News";
      const date = cleanString(item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]);
      return { headline, source, date, riskLevel: "medium" };
    }).filter((item) => item.headline);
  } catch {
    return [];
  }
}

async function getGdeltArticles(query) {
  try {
    const params = new URLSearchParams({ query, mode: "ArtList", format: "json", maxrecords: "10", sort: "HybridRel" });
    const data = await fetchJson(`${GDELT_DOC_API}?${params.toString()}`);
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    return articles.slice(0, 5).map((article) => ({
      headline: cleanString(article?.title || article?.seendate || "Untitled"),
      source: cleanString(article?.source || article?.domain || "GDELT"),
      date: cleanString(article?.seendate || article?.socialimage || ""),
      riskLevel: "medium"
    }));
  } catch {
    return [];
  }
}

async function getPerplexityArticles(query) {
  if (!process.env.PPLX_API_KEY) return [];
  try {
    const data = await fetchJson("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PPLX_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: `List up to 3 adverse media headlines with source and date for: ${query}. Return JSON array.` }]
      })
    });

    const content = data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return Array.isArray(parsed)
      ? parsed
          .map((row) => ({
            headline: cleanString(row?.headline),
            source: cleanString(row?.source) || "Perplexity",
            date: cleanString(row?.date),
            riskLevel: "high"
          }))
          .filter((row) => row.headline)
      : [];
  } catch {
    return [];
  }
}

async function getOpenSanctionsAdverse(companyName) {
  if (!companyName || !process.env.OPENSANCTIONS_KEY) return [];
  try {
    const data = await fetchJson(OPENSANCTIONS_MATCH_API, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${process.env.OPENSANCTIONS_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        queries: { q1: { schema: "Company", properties: { name: companyName } } },
        limit: 20
      })
    });

    const results = Array.isArray(data?.responses?.q1?.results) ? data.responses.q1.results : [];
    return results
      .filter((row) => String(row?.schema || "").toLowerCase().includes("legalentity") || row?.topics?.includes("crime"))
      .slice(0, 5)
      .map((row) => ({
        headline: `${cleanString(row?.caption || row?.name)} flagged in compliance data`,
        source: "OpenSanctions",
        date: null,
        riskLevel: "high"
      }))
      .filter((row) => row.headline);
  } catch {
    return [];
  }
}

async function getAdverseMedia(companyName) {
  if (!companyName) return toNoDataFound();

  const queries = [
    companyName,
    `${companyName} fraud`,
    `${companyName} investigation`,
    `${companyName} lawsuit`,
    `${companyName} corruption`
  ];

  const all = [];
  for (const query of queries) {
    const [gdelt, googleNews, perplexity] = await Promise.all([
      getGdeltArticles(query),
      getGoogleNewsArticles(query),
      getPerplexityArticles(query)
    ]);
    all.push(...gdelt, ...googleNews, ...perplexity);
  }
  all.push(...(await getOpenSanctionsAdverse(companyName)));

  const deduped = [];
  const seen = new Set();
  for (const row of all) {
    const key = `${row.headline}|${row.source}`.toLowerCase();
    if (!row.headline || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped.length ? deduped : toNoDataFound();
}

async function getPublicKnowledgeGraph(companyName) {
  if (!companyName) return toNoDataFound();

  const response = {
    wikipedia: null,
    wikidata: null,
    googleKnowledgeGraph: null
  };

  try {
    const wikiParams = new URLSearchParams({ action: "query", list: "search", srsearch: companyName, format: "json" });
    const wikiData = await fetchJson(`${WIKIPEDIA_SEARCH_API}?${wikiParams.toString()}`);
    const hit = wikiData?.query?.search?.[0];
    if (hit?.title) {
      response.wikipedia = {
        title: hit.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/\s+/g, "_"))}`
      };
    }
  } catch {
    response.wikipedia = null;
  }

  try {
    const wdParams = new URLSearchParams({ action: "wbsearchentities", format: "json", language: "en", search: companyName, limit: "1" });
    const wdData = await fetchJson(`${WIKIDATA_SEARCH_API}?${wdParams.toString()}`);
    const hit = Array.isArray(wdData?.search) ? wdData.search[0] : null;
    if (hit?.id) {
      response.wikidata = {
        id: hit.id,
        label: hit.label,
        description: hit.description || null,
        url: `https://www.wikidata.org/wiki/${hit.id}`
      };
    }
  } catch {
    response.wikidata = null;
  }

  if (process.env.GOOGLE_KG_API_KEY) {
    try {
      const kgParams = new URLSearchParams({ query: companyName, key: process.env.GOOGLE_KG_API_KEY, limit: "1", indent: "True" });
      const kgData = await fetchJson(`https://kgsearch.googleapis.com/v1/entities:search?${kgParams.toString()}`);
      const hit = Array.isArray(kgData?.itemListElement) ? kgData.itemListElement[0] : null;
      if (hit?.result?.name) {
        response.googleKnowledgeGraph = {
          name: hit.result.name,
          description: hit.result.description || null,
          detailedDescription: hit.result?.detailedDescription?.url || null
        };
      }
    } catch {
      response.googleKnowledgeGraph = null;
    }
  }

  return response.wikipedia || response.wikidata || response.googleKnowledgeGraph ? response : toNoDataFound();
}

async function getSanctions(companyName) {
  if (!companyName || !process.env.OPENSANCTIONS_KEY) return toNoDataFound();
  try {
    const data = await fetchJson(OPENSANCTIONS_MATCH_API, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${process.env.OPENSANCTIONS_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ queries: { q1: { schema: "Company", properties: { name: companyName } } }, limit: 50 })
    });

    const results = Array.isArray(data?.responses?.q1?.results) ? data.responses.q1.results : [];
    const matches = [];

    for (const result of results) {
      const entityName = cleanString(result?.caption || result?.name);
      if (!entityName) continue;

      const similarity = similarityScore(companyName, entityName);
      const classification = classifySimilarity(similarity);
      if (!classification.match) continue;

      const datasets = Array.isArray(result?.match?.datasets)
        ? result.match.datasets
        : Array.isArray(result?.datasets)
          ? result.datasets
          : [];

      for (const dataset of datasets) {
        const normalized = String(dataset || "").toLowerCase();
        const source = SANCTIONS_DATASETS.find((item) => normalized.includes(item.key));
        if (!source) continue;

        matches.push({
          name: entityName,
          dataset: source.label,
          confidence: similarity,
          country: cleanString(result?.properties?.country?.[0] || result?.country || null),
          source: "OpenSanctions"
        });
      }
    }

    return matches.length ? matches : toNoDataFound();
  } catch {
    return toNoDataFound();
  }
}

async function getCorporateNetwork(ownership) {
  const directors = Array.isArray(ownership?.directors) ? ownership.directors : [];
  if (!directors.length) return [];

  return directors.map((entry) => ({ director: entry.name, companies: entry.otherCompanies || [] }));
}

function buildAddressVerification(corporateRegistry, websiteAnalysis, publicKnowledgeGraph) {
  if (!corporateRegistry || corporateRegistry.status === "no data found") return toNoDataFound();

  const addresses = [corporateRegistry.registeredAddress, websiteAnalysis?.address];
  if (publicKnowledgeGraph?.googleKnowledgeGraph?.description) {
    addresses.push(...extractAddressCandidates(publicKnowledgeGraph.googleKnowledgeGraph.description));
  }

  const cleaned = uniqueStrings(addresses);
  if (!cleaned.length) return toNoDataFound();

  return {
    registeredAddress: cleaned[0],
    confidence: cleaned.length > 1 ? 0.85 : 0.75
  };
}

async function collectAdditionalIntelligence(companyName, website) {
  const [searchDiscovery, corporateRegistry, websiteAnalysis, publicKnowledgeGraph, sanctions, adverseMedia] = await Promise.all([
    getGlobalSearchDiscovery(companyName),
    getCorporateRegistry(companyName),
    getWebsiteAnalysis(website),
    getPublicKnowledgeGraph(companyName),
    getSanctions(companyName),
    getAdverseMedia(companyName)
  ]);

  const ownership = await getOwnership(corporateRegistry);
  const corporateNetwork = await getCorporateNetwork(ownership);
  const addressVerification = buildAddressVerification(corporateRegistry, websiteAnalysis, publicKnowledgeGraph);

  const intelligence = {
    corporateRegistry,
    ownership,
    addressVerification,
    websiteAnalysis,
    adverseMedia,
    publicKnowledgeGraph,
    corporateNetwork,
    sanctions,
    domainIntelligence: null,
    sourceDiscovery: searchDiscovery
  };

  intelligence.media = adverseMedia;
  intelligence.knowledge = publicKnowledgeGraph;
  intelligence.network = { summary: corporateNetwork.length ? `${corporateNetwork.length} director links identified.` : "No high-risk ownership links were identified." };

  return intelligence;
}

module.exports = {
  extractDomain,
  collectAdditionalIntelligence,
  getCorporateRegistry,
  getWebsiteAnalysis,
  getAdverseMedia,
  getPublicKnowledgeGraph,
  getCorporateNetwork,
  getGlobalSearchDiscovery,
  getSanctions
};
