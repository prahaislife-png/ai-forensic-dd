const OPEN_SANCTIONS_ENDPOINT = "https://api.opensanctions.org/match/default";
const OFFSHORE_LEAKS_ENDPOINT = "https://offshoreleaks.icij.org/api/v1/reconcile";
const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions";
const { collectEvidence } = require("./evidence");

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

function normalizeSourcesAtEnd(report = "") {
  const raw = String(report || "").trim();
  if (!raw) return "";

  const sourceHeaderRegex = /\n\s*(?:#{2,3}\s*|\*\*\s*)?sources(?:\s*\*\*)?\s*:?\s*\n?/i;
  const sourceHeaderMatch = sourceHeaderRegex.exec(raw);

  let body = raw;
  let sourceBlock = "";

  if (sourceHeaderMatch) {
    body = raw.slice(0, sourceHeaderMatch.index).trimEnd();
    sourceBlock = raw.slice(sourceHeaderMatch.index + sourceHeaderMatch[0].length).trim();
  }

  const parsedUrls = sourceBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sourceLineMatch = line.match(/^\[(\d+)\]\s+(https?:\/\/\S+)$/i);
      if (!sourceLineMatch) return null;
      return { number: sourceLineMatch[1], url: sourceLineMatch[2] };
    })
    .filter(Boolean);

  if (!parsedUrls.length) {
    return body;
  }

  const normalizedSources = [
    "Sources",
    "",
    ...parsedUrls.map((source) => `[${source.number}] ${source.url}`)
  ].join("\n");

  return [body, normalizedSources].filter(Boolean).join("\n\n");
}

function limitInlineCitations(report = "") {
  return String(report || "").replace(/(?:\[(\d+)\]){3,}/g, (match) => {
    const citations = [...match.matchAll(/\[(\d+)\]/g)].map((entry) => entry[0]);
    return citations.slice(0, 2).join("");
  });
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
    const evidence = await collectEvidence(company, website);
    const evidenceBlock = evidence
      .map((e, i) => `[${i + 1}] ${e.url}\n${e.snippet}`)
      .join("\n\n");
    const evidenceSourcesList = evidence
      .map((e, i) => `[${i + 1}] ${e.url}`)
      .join("\n");

    const promptWithScreening = [
      "You are a forensic due diligence analyst.",
      "",
      "You must follow STRICT evidence-based reasoning.",
      "",
      "Rules:",
      "",
      "• Only use information from the provided evidence list.",
      "• Every factual claim must cite at least one evidence source.",
      "• Never invent companies, entities, or matches.",
      "• Never speculate about sanctions or offshore ownership without evidence.",
      "• If the evidence does not support a claim, write:",
      "",
      "\"No verifiable evidence found in available sources.\"",
      "",
      "• Never cite a number that does not exist in the evidence list.",
      "",
      "Example:",
      "",
      "Incorrect:",
      "Potential sanctions match found.",
      "",
      "Correct:",
      "No sanctions matches were identified in the collected evidence sources.",
      "",
      "Investigate the following company using public information and provide a structured due diligence report.",
      "",
      `Company: ${company || "Unknown"}`,
      `Country: ${country || "Unknown"}`,
      `Website: ${website || "Unknown"}`,
      "",
      "Include the following sections:",
      "",
      "Company Overview",
      "Ownership & Management",
      "Address Verification",
      "Offshore Ownership Screening",
      "Media & Reputation",
      "Legal & Regulatory Issues",
      "Sanctions Screening",
      "Risk Conclusion",
      "",
      "Treat potential findings conservatively:",
      "- potential sanctions similarity -> HIGH risk until independently verified",
      "- offshore ownership match -> MEDIUM risk",
      "- regulatory inconsistencies -> MEDIUM risk",
      "",
      "You must ONLY use the evidence sources listed below.",
      "Every factual claim must reference at least one evidence citation.",
      "Do NOT make assumptions or interpretations beyond the evidence.",
      "If evidence is insufficient for any claim, state: \"No verifiable evidence found in available sources.\"",
      "Risk conclusions must be based only on the provided evidence.",
      "Never invent sources.",
      "Never fabricate URLs.",
      "Never cite numbers higher than the evidence list.",
      "If information is not supported by the evidence, do not cite it.",
      "",
      "Analyze the following evidence and produce a forensic due diligence report.",
      "",
      "Evidence sources:",
      evidenceBlock || "No evidence sources found.",
      "",
      "Keep citation markers [1], [2], etc in the report text as used.",
      "Use a maximum of 2 citations per sentence.",
      "Prefer one citation when possible, and never produce citation chains like [1][2][3].",
      "Add a Sources section ONLY at the end of the report, AFTER Risk Conclusion, in this exact format:",
      "Sources",
      "",
      evidenceSourcesList || "[1] https://example.com",
      "Plain URLs only. Do not include HTML anchor tags.",
      "Only include the exact URLs from the evidence list in Sources.",
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
    const citationLimitedResult = limitInlineCitations(modelResult);

    res.status(200).json({
      result: normalizeSourcesAtEnd(citationLimitedResult)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}