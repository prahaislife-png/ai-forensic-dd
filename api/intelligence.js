const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const WIKIPEDIA_SEARCH_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_ENTITY_API = "https://www.wikidata.org/w/api.php";
const OPENCORPORATES_COMPANY_SEARCH_API = "https://api.opencorporates.com/v0.4/companies/search";
const OPENCORPORATES_OFFICER_SEARCH_API = "https://api.opencorporates.com/v0.4/officers/search";

function parseDomain(website = "") {
  if (!website) return "";

  const candidate = website.trim();
  if (!candidate) return "";

  try {
    const normalized = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    return new URL(normalized).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json();
}

async function getMediaIntel(companyName) {
  if (!companyName) {
    return {
      query: "",
      articleCount: 0,
      topArticles: [],
      summary:
        "No adverse global media coverage associated with the company or its leadership was identified in monitored news sources."
    };
  }

  try {
    const query = `"${companyName}" AND (fraud OR corruption OR sanction OR bribery OR money laundering OR lawsuit)`;
    const params = new URLSearchParams({
      query,
      mode: "ArtList",
      format: "json",
      maxrecords: "5",
      sort: "HybridRel"
    });

    const data = await fetchJson(`${GDELT_DOC_API}?${params.toString()}`);
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    const topArticles = articles.slice(0, 3).map((article) => ({
      title: article?.title || "Untitled",
      source: article?.source || article?.domain || "Unknown",
      url: article?.url || ""
    }));

    const summary = articles.length
      ? `Adverse media signals were identified across ${articles.length} global news result(s) for the monitored query.`
      : "No adverse global media coverage associated with the company or its leadership was identified in monitored news sources.";

    return {
      query,
      articleCount: articles.length,
      topArticles,
      summary
    };
  } catch {
    return {
      query: companyName,
      articleCount: 0,
      topArticles: [],
      summary:
        "No adverse global media coverage associated with the company or its leadership was identified in monitored news sources."
    };
  }
}

async function getDomainIntel(website) {
  const domain = parseDomain(website);
  if (!domain) {
    return {
      domain: "N/A",
      registeredYear: "Unknown",
      registrar: "Unknown",
      status: "Unknown",
      summary: "No domain information available."
    };
  }

  try {
    const data = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
    const events = Array.isArray(data?.events) ? data.events : [];
    const registrationEvent = events.find((event) => event?.eventAction === "registration");
    const registrationDate = registrationEvent?.eventDate || "";

    const registeredYear = registrationDate ? String(new Date(registrationDate).getUTCFullYear()) : "Unknown";

    const registrarEntity = Array.isArray(data?.entities)
      ? data.entities.find((entity) =>
          Array.isArray(entity?.roles) && entity.roles.some((role) => /registrar/i.test(role))
        )
      : null;

    const registrar =
      registrarEntity?.vcardArray?.[1]?.find((item) => item?.[0] === "fn")?.[3] ||
      registrarEntity?.handle ||
      "Unknown";

    const status = Array.isArray(data?.status) && data.status.length ? data.status.join(", ") : "Active";

    return {
      domain,
      registeredYear,
      registrar,
      status,
      summary: `Domain ${domain} is registered with ${registrar} and is currently ${status}.`
    };
  } catch {
    return {
      domain,
      registeredYear: "Not available",
      registrar: "Not available",
      status: "Not available",
      summary: `Domain intelligence could not be confirmed for ${domain}.`
    };
  }
}

async function getKnowledgeIntel(companyName) {
  if (!companyName) {
    return {
      wikipediaTitle: null,
      wikipediaUrl: null,
      wikidataId: null,
      summary:
        "No verified Wikipedia or Wikidata entity was identified for the company in public knowledge graph datasets."
    };
  }

  try {
    const searchParams = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: companyName,
      srlimit: "10",
      format: "json"
    });

    const searchData = await fetchJson(`${WIKIPEDIA_SEARCH_API}?${searchParams.toString()}`);
    const searchResults = Array.isArray(searchData?.query?.search) ? searchData.query.search : [];
    const normalizedCompanyName = companyName.toLowerCase();
    const topResult = searchResults.find((result) =>
      result?.title?.toLowerCase().includes(normalizedCompanyName)
    );

    if (!topResult?.title) {
      return {
        wikipediaTitle: null,
        wikipediaUrl: null,
        wikidataId: null,
        summary:
          "No verified Wikipedia or Wikidata entity was identified for the company in public knowledge graph datasets."
      };
    }

    const title = topResult.title;
    const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;

    const wikidataParams = new URLSearchParams({
      action: "wbsearchentities",
      search: companyName,
      language: "en",
      limit: "10",
      format: "json"
    });

    let wikidataId = null;
    try {
      const wikidataData = await fetchJson(`${WIKIDATA_ENTITY_API}?${wikidataParams.toString()}`);
      const wikidataResults = Array.isArray(wikidataData?.search) ? wikidataData.search : [];
      const matchedWikidata = wikidataResults.find((result) =>
        result?.label?.toLowerCase().includes(normalizedCompanyName)
      );
      wikidataId = matchedWikidata?.id || null;
    } catch {
      wikidataId = null;
    }

    return {
      wikipediaTitle: title,
      wikipediaUrl,
      wikidataId,
      summary: `Public knowledge graph references were identified for ${title}.`
    };
  } catch {
    return {
      wikipediaTitle: null,
      wikipediaUrl: null,
      wikidataId: null,
      summary:
        "No verified Wikipedia or Wikidata entity was identified for the company in public knowledge graph datasets."
    };
  }
}

async function getNetworkIntel(companyName) {
  if (!companyName) {
    return {
      relatedCompanies: [],
      relatedOfficers: [],
      summary:
        "No high-risk ownership links or sanctioned entities were identified within the corporate relationship network."
    };
  }

  try {
    const companyParams = new URLSearchParams({
      q: companyName,
      per_page: "5"
    });
    const officerParams = new URLSearchParams({
      q: companyName,
      per_page: "5"
    });

    const [companyData, officerData] = await Promise.all([
      fetchJson(`${OPENCORPORATES_COMPANY_SEARCH_API}?${companyParams.toString()}`),
      fetchJson(`${OPENCORPORATES_OFFICER_SEARCH_API}?${officerParams.toString()}`)
    ]);

    const relatedCompanies = Array.isArray(companyData?.results?.companies)
      ? companyData.results.companies.slice(0, 3).map((entry) => ({
          name: entry?.company?.name || "Unknown",
          jurisdiction: entry?.company?.jurisdiction_code || "Unknown",
          companyNumber: entry?.company?.company_number || "Unknown"
        }))
      : [];

    const relatedOfficers = Array.isArray(officerData?.results?.officers)
      ? officerData.results.officers.slice(0, 3).map((entry) => ({
          name: entry?.officer?.name || "Unknown",
          position: entry?.officer?.position || "Unknown",
          company: entry?.officer?.company?.name || "Unknown"
        }))
      : [];

    const hasSignals = relatedCompanies.length || relatedOfficers.length;
    const summary = hasSignals
      ? `Corporate network mapping identified ${relatedCompanies.length} related compan${
          relatedCompanies.length === 1 ? "y" : "ies"
        } and ${relatedOfficers.length} related officer record${relatedOfficers.length === 1 ? "" : "s"}.`
      : "No high-risk ownership links or sanctioned entities were identified within the corporate relationship network.";

    return {
      relatedCompanies,
      relatedOfficers,
      summary
    };
  } catch {
    return {
      relatedCompanies: [],
      relatedOfficers: [],
      summary:
        "No high-risk ownership links or sanctioned entities were identified within the corporate relationship network."
    };
  }
}

async function collectAdditionalIntelligence(companyName, website) {
  const [media, domain, knowledge, network] = await Promise.all([
    getMediaIntel(companyName),
    getDomainIntel(website),
    getKnowledgeIntel(companyName),
    getNetworkIntel(companyName)
  ]);

  return {
    media,
    domain,
    knowledge,
    network
  };
}

module.exports = {
  collectAdditionalIntelligence,
  getMediaIntel,
  getDomainIntel,
  getKnowledgeIntel,
  getNetworkIntel
};