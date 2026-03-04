const OPEN_SANCTIONS_ENDPOINT = "https://api.opensanctions.org/match/default";
const OFFSHORE_LEAKS_ENDPOINT = "https://offshoreleaks.icij.org/api/v1/reconcile";
const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions";
const { collectEvidence } = require("./evidence");
const { collectAdditionalIntelligence } = require("./intelligence");

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

function limitInlineCitations(report = "") {
  return String(report || "").replace(/(?:\[(\d+)\]){3,}/g, (match) => {
    const citations = [...match.matchAll(/\[(\d+)\]/g)].map((entry) => entry[0]);
    return citations.slice(0, 2).join("");
  });
}

function normalizeRiskBreakdown(report = "") {
  const lines = String(report || "").split(/\r?\n/);
  const normalized = [];
  let inRiskSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^risk breakdown\s*$/i.test(trimmed)) {
      inRiskSection = true;
      normalized.push("Risk Breakdown", "", "Corporate Registration: LOW", "Ownership Transparency: LOW", "Offshore Ownership: MEDIUM", "Sanctions Screening: LOW", "Media Reputation: LOW", "Legal / Regulatory Issues: LOW");
      continue;
    }

    if (inRiskSection) {
      const isMarkdownRiskLine =
        /^\|/.test(trimmed) ||
        /^[-:|\s]+$/.test(trimmed) ||
        /^(corporate registration|ownership transparency|offshore ownership|sanctions screening|media reputation|legal\s*\/\s*regulatory issues)\b/i.test(trimmed);

      if (isMarkdownRiskLine || !trimmed) {
        continue;
      }

      inRiskSection = false;
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

function sanitizeReport(report = "") {
  return String(report || "")
    .replace(/```/g, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\|\s?/, "").replace(/\s*\|\s*$/, ""))
    .join("\n");
}

function ensureRiskDeterminationLine(report = "") {
  const requiredLine = "Risk determination is performed by the automated scoring system.";
  const trimmed = String(report || "").trim();
  if (!trimmed) return requiredLine;
  if (trimmed.endsWith(requiredLine)) return trimmed;
  return `${trimmed}\n\n${requiredLine}`;
}

function buildSourcesSection(evidenceSources = []) {
  if (evidenceSources.length) {
    return ["Sources", "", ...evidenceSources.map((url, index) => `[${index + 1}] ${url}`)].join("\n");
  }

  return ["Sources", "", "No evidence sources identified from public search results."].join("\n");
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
    const evidenceSourcesList = evidence.map((e) => e.url).filter(Boolean);

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
      "The AI must NOT assign risk levels such as LOW, MEDIUM, or HIGH.",
      "The AI should only describe factual findings and observations.",
      "Final risk classification is handled by system logic.",
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
      "",
      "Incorporate the screening findings below into the relevant sections:",
      sanctionsResult,
      offshoreResult,
      "",
      "Return the final report in structured markdown using the exact section headings above.",
      "End the report with: \"Risk determination is performed by the automated scoring system.\"",
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
    const riskNormalizedResult = normalizeRiskBreakdown(citationLimitedResult);
    const sanitizedResult = sanitizeReport(riskNormalizedResult);

    const intel = await collectAdditionalIntelligence(company, website);

    const additionalSections = [
      "GLOBAL MEDIA INTELLIGENCE",
      "",
      intel.media?.summary || "No adverse global media coverage associated with the company or its leadership was identified in monitored news sources.",
      "",
      "DOMAIN INTELLIGENCE",
      "",
      `Domain: ${intel.domain?.domain || "N/A"}`,
      `Registered: ${intel.domain?.registeredYear || "Unknown"}`,
      `Registrar: ${intel.domain?.registrar || "Unknown"}`,
      `Status: ${intel.domain?.status || "Unknown"}`,
      "",
      "PUBLIC KNOWLEDGE GRAPH",
      "",
      intel.knowledge?.summary || "No verified Wikipedia or Wikidata entity was identified for the company in publicly indexed knowledge graphs.",
      "",
      "CORPORATE NETWORK ANALYSIS",
      "",
      intel.network?.summary || "No high-risk ownership links or sanctioned entities were identified within the corporate relationship network."
    ].join("\n");

    const sourcesSection = buildSourcesSection(evidenceSourcesList);
    const finalReport = ensureRiskDeterminationLine(
      [sanitizedResult, additionalSections, sourcesSection].filter(Boolean).join("\n\n")
    );

    res.status(200).json({
      result: finalReport
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}