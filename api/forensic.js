const OPEN_SANCTIONS_ENDPOINT = "https://api.opensanctions.org/match/default";
const OFFSHORE_LEAKS_ENDPOINT = "https://offshoreleaks.icij.org/api/v1/reconcile";
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

function formatSourceLink(number, url) {
  const safeUrl = escapeHtml(url);
  return `[${number}] <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
}

function normalizeReportSources(report = "") {
  const raw = String(report || "").trim();
  if (!raw) return "";

  const sourcesHeaderRegex = /\n\s*(?:#{2,3}\s*|\*\*\s*)?sources(?:\s*\*\*)?\s*:?\s*\n?/i;
  const sourcesMatch = sourcesHeaderRegex.exec(raw);

  if (!sourcesMatch) {
    return raw.replace(/\[(\d+)\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
  }

  const reportBody = raw.slice(0, sourcesMatch.index).trimEnd();
  const rawSources = raw
    .slice(sourcesMatch.index + sourcesMatch[0].length)
    .trim();

  const parsedSources = rawSources
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const lineMatch = line.match(/^\[(\d+)\]\s+(.+)$/);
      if (!lineMatch) return null;

      const originalNumber = Number(lineMatch[1]);
      const candidate = lineMatch[2].trim();

      if (!isValidHttpUrl(candidate)) return null;

      return { originalNumber, url: candidate };
    })
    .filter(Boolean);

  if (!parsedSources.length) {
    return reportBody.replace(/\[(\d+)\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
  }

  const renumberMap = new Map();
  const normalizedSources = parsedSources.map((source, index) => {
    const number = index + 1;
    renumberMap.set(source.originalNumber, number);
    return { number, url: source.url };
  });

  const normalizedBody = reportBody
    .replace(/\[(\d+)\]/g, (_, sourceNumber) => {
      const mapped = renumberMap.get(Number(sourceNumber));
      return mapped ? `[${mapped}]` : "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const sourcesSection = [
    "Sources:",
    "",
    ...normalizedSources.map((source) => formatSourceLink(source.number, source.url))
  ].join("\n");

  return [normalizedBody, sourcesSection].filter(Boolean).join("\n\n");
}

function extractCompanyFromPrompt(prompt = "") {
  const match = prompt.match(/report for\s+(.+?)\.\s+country:/i);
  if (match?.[1]?.trim()) return match[1].trim();

  const fallbackMatch = prompt.match(/company\s*:\s*(.+)$/im);
  return fallbackMatch?.[1]?.trim() || "";
}

function extractCountryFromPrompt(prompt = "") {
  const match = prompt.match(/country\s*:\s*([^\.\n]+)/i);
  return match?.[1]?.trim() || "";
}

function extractWebsiteFromPrompt(prompt = "") {
  const match = prompt.match(/website\s*:\s*([^\.\n\s]+)/i);
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

export default async function handler(req, res) {
  try {
    const incomingPrompt = req.body?.prompt || "";
    const company = req.body?.company || extractCompanyFromPrompt(incomingPrompt);
    const country = req.body?.country || extractCountryFromPrompt(incomingPrompt);
    const website = req.body?.website || extractWebsiteFromPrompt(incomingPrompt);

    const sanctionsResult = await getSanctionsScreening(company);
    const offshoreResult = await getOffshoreScreening(company);

    const promptWithScreening = [
      "You are a forensic due diligence analyst.",
      "",
      "Investigate the following company using public information and provide a structured due diligence report.",
      "",
      `Company: ${company || "Unknown"}`,
      `Country: ${country || "Unknown"}`,
      `Website: ${website || "Unknown"}`,
      "",
      "Include the following sections:",
      "",
      "## Company Overview",
      "## Ownership & Management",
      "## Address Verification",
      "## Offshore Ownership Screening",
      "## Media & Reputation",
      "## Legal & Regulatory Issues",
      "## Sanctions Screening",
      "## Risk Conclusion",
      "",
      "If information is limited, provide the most likely publicly available details rather than stating 'no data available'.",
      "",
      "Whenever you use citation markers like [1], [2], etc, you MUST include a 'Sources' section at the end of the report listing the exact URLs.",
      "The Sources section must appear AFTER the Risk Conclusion section.",
      "Format Sources exactly like:",
      "Sources:",
      "",
      "[1] https://example.com",
      "[2] https://example.com",
      "[3] https://example.com",
      "Only list real URLs. Do not use generic placeholders such as 'business directories', 'public sources', or 'company website'.",
      "If no reliable sources are available, remove citation numbers from the report text.",
      "",
      "Incorporate the screening findings below into the relevant sections:",
      sanctionsResult,
      offshoreResult,
      "",
      "Return the final report in structured markdown using the exact section headings above.",
      "End with FLAG: GREEN or FLAG: YELLOW or FLAG: RED.",
      "",
      "Original user request:",
      incomingPrompt
    ].join("\n");

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

    res.status(200).json({
      result: normalizeReportSources(modelResult)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}