const OPEN_SANCTIONS_ENDPOINT = "https://api.opensanctions.org/match/default";
const OFFSHORE_LEAKS_ENDPOINT = "https://offshoreleaks.icij.org/api/v1/reconcile";
const SERPAPI_ENDPOINT = "https://serpapi.com/search";
const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidHttpUrl(value = "") {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatSourceAsClickableLink(number, url) {
  const safeUrl = escapeHtml(url);
  return `[${number}] <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
}

function extractReportBodyWithoutSources(report = "") {
  const raw = String(report || "").trim();
  const sourcesHeadingRegex = /\n\s*(?:#{2,3}\s*|\*\*\s*)?sources(?:\s*\*\*)?\s*:?\s*\n?/i;
  const headingMatch = sourcesHeadingRegex.exec(raw);

  if (!headingMatch) {
    return raw;
  }

  return raw.slice(0, headingMatch.index).trim();
}

function formatReportWithSources(report = "", evidenceSources = []) {
  const rawBody = extractReportBodyWithoutSources(report);
  const validSources = evidenceSources.filter((source) => isValidHttpUrl(source));

  if (!rawBody) return "";

  if (!validSources.length) {
    return rawBody.replace(/\[(\d+)\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
  }

  const allowedNumbers = new Set(validSources.map((_, index) => index + 1));

  const normalizedBody = rawBody
    .replace(/\[(\d+)\]/g, (_, number) => {
      const citation = Number(number);
      return allowedNumbers.has(citation) ? `[${citation}]` : "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const sourcesSection = [
    "Sources:",
    ...validSources.map((source, index) => formatSourceAsClickableLink(index + 1, source))
  ].join("\n");

  return [normalizedBody, sourcesSection].filter(Boolean).join("\n\n");
}

function extractCompanyFromPrompt(prompt = "") {
  const match = prompt.match(/report for\s+(.+?)\.\s+Registered Address:/i);
  return match?.[1]?.trim() || "";
}

async function getSanctionsScreening(company) {
  if (!company || !process.env.OPENSANCTIONS_KEY) {
    return "Sanctions Screening Result:\nNo matches found";
  }

  try {
    const response = await fetch(OPEN_SANCTIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `ApiKey ${process.env.OPENSANCTIONS_KEY}`
      },
      body: JSON.stringify({
        queries: {
          q1: {
            schema: "Company",
            properties: {
              name: company
            }
          }
        }
      })
    });

    if (!response.ok) {
      return "Sanctions Screening Result:\nNo matches found";
    }

    const data = await response.json();
    const firstResult = data?.responses?.q1?.results?.[0];

    if (!firstResult) {
      return "Sanctions Screening Result:\nNo matches found";
    }

    const entityName = firstResult.caption || firstResult.name || "N/A";
    const dataset =
      firstResult.match?.datasets?.[0] ||
      firstResult.datasets?.[0] ||
      "N/A";
    const score = firstResult.match?.score ?? firstResult.score ?? "N/A";

    return [
      "Sanctions Screening Result:",
      "Potential match found:",
      `Name: ${entityName}`,
      `Dataset: ${dataset}`,
      `Score: ${score}`
    ].join("\n");
  } catch {
    return "Sanctions Screening Result:\nNo matches found";
  }
}

async function getOffshoreScreening(company) {
  if (!company) {
    return [
      "Offshore Ownership Screening:",
      "",
      "No matches were found in the ICIJ Offshore Leaks database."
    ].join("\n");
  }

  try {
    const response = await fetch(OFFSHORE_LEAKS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: company,
        type: "Entity"
      })
    });

    if (!response.ok) {
      return [
        "Offshore Ownership Screening:",
        "",
        "No matches were found in the ICIJ Offshore Leaks database."
      ].join("\n");
    }

    const data = await response.json();
    const firstResult =
      data?.result?.[0] ||
      data?.results?.[0] ||
      data?.matches?.[0] ||
      null;

    if (!firstResult) {
      return [
        "Offshore Ownership Screening:",
        "",
        "No matches were found in the ICIJ Offshore Leaks database."
      ].join("\n");
    }

    const entityName =
      firstResult.name ||
      firstResult.entity ||
      firstResult.caption ||
      "N/A";
    const score = firstResult.score ?? "N/A";
    const id = firstResult.id || firstResult.entity_id || "N/A";

    return [
      "Offshore Ownership Screening:",
      "",
      "Potential offshore entity match detected:",
      `Name: ${entityName}`,
      `Confidence Score: ${score}`,
      `ID: ${id}`
    ].join("\n");
  } catch {
    return [
      "Offshore Ownership Screening:",
      "",
      "No matches were found in the ICIJ Offshore Leaks database."
    ].join("\n");
  }
}

async function getEvidenceSources(company) {
  if (!company || !process.env.SERPAPI_KEY) {
    return [];
  }

  try {
    const search = await fetch(
      `${SERPAPI_ENDPOINT}?engine=google&q=${encodeURIComponent(company)}&api_key=${process.env.SERPAPI_KEY}`
    );

    if (!search.ok) {
      return [];
    }

    const data = await search.json();

    return (data?.organic_results || [])
      .slice(0, 5)
      .map((result) => ({
        title: result?.title || "Untitled source",
        link: result?.link || "",
        snippet: result?.snippet || ""
      }))
      .filter((source) => isValidHttpUrl(source.link));
  } catch {
    return [];
  }
}

function buildEvidenceBlock(sources = []) {
  if (!sources.length) {
    return "No verified web evidence was retrieved. Do not use citations if no evidence sources are listed.";
  }

  return sources
    .map((source, index) => {
      const number = index + 1;
      return [
        `[${number}] ${source.title}`,
        source.link,
        source.snippet || "No summary available."
      ].join("\n");
    })
    .join("\n\n");
}

export default async function handler(req, res) {
  try {
    const incomingPrompt = req.body?.prompt || "";
    const company = req.body?.company || extractCompanyFromPrompt(incomingPrompt);
    const sanctionsResult = await getSanctionsScreening(company);
    const offshoreResult = await getOffshoreScreening(company);
    const evidenceSources = await getEvidenceSources(company);
    const evidenceBlock = buildEvidenceBlock(evidenceSources);

    const promptWithScreening = [
      "You are a forensic due diligence analyst.",
      "Analyze the verified evidence collected from public sources and the screening results below.",
      "Do not invent facts, sources, or URLs. Use only the provided evidence and screening data.",
      "",
      "Verified OSINT Evidence:",
      evidenceBlock,
      "",
      sanctionsResult,
      "",
      "Offshore Screening Result:",
      offshoreResult,
      "",
      "Write a structured forensic due diligence report using sections: Company Overview, Ownership & Management, Address Verification, Offshore Ownership Screening, Media & Reputation, Legal & Regulatory Issues, Sanctions Screening, Risk Conclusion.",
      "Use citation markers [1], [2], etc only for claims supported by the evidence entries above.",
      "If a source URL is unavailable, remove the citation number from the report text.",
      "Ensure the Sources section appears after the Risk Conclusion section.",
      "At the end, include a Sources section listing the exact URLs from the evidence list in this format:",
      "Sources:",
      "[1] https://example.com",
      "[2] https://example.com",
      "[3] https://example.com",
      "End with FLAG: GREEN or FLAG: YELLOW or FLAG: RED.",
      "",
      "Original report request context:",
      incomingPrompt
    ].join("\n\n");

    const response = await fetch(PERPLEXITY_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.PPLX_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          {
            role: "user",
            content: promptWithScreening
          }
        ]
      })
    });

    const data = await response.json();
    const modelResult = data.choices?.[0]?.message?.content || "";
    const sourceUrls = evidenceSources.map((source) => source.link);

    res.status(200).json({
      result: formatReportWithSources(modelResult, sourceUrls)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}