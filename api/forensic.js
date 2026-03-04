const OPEN_SANCTIONS_ENDPOINT = "https://api.opensanctions.org/match/default";
const OFFSHORE_LEAKS_ENDPOINT = "https://offshoreleaks.icij.org/api/v1/reconcile";
const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions";

function formatReportWithSources(report = "") {
  const raw = String(report || "").trim();

  if (!raw) return "";

  const sourcesHeadingRegex = /\n\s*(?:#{2,3}\s*|\*\*\s*)?sources(?:\s*\*\*)?\s*:\s*\n?/i;
  const headingMatch = sourcesHeadingRegex.exec(raw);

  if (!headingMatch) {
    return raw.replace(/\[(\d+)\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
  }

  const body = raw.slice(0, headingMatch.index).trimEnd();
  const sourcesBlock = raw
    .slice(headingMatch.index + headingMatch[0].length)
    .trim();

  const sourceLines = sourcesBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsedSources = sourceLines
    .map((line) => {
      const match = line.match(/^\[(\d+)\]\s+(.+)$/);

      if (!match) return null;

      return {
        originalNumber: Number(match[1]),
        text: match[2].trim()
      };
    })
    .filter(Boolean);

  if (!parsedSources.length) {
    return body.replace(/\[(\d+)\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
  }

  const renumberMap = new Map();
  const normalizedSources = parsedSources.map((source, index) => {
    const newNumber = index + 1;
    renumberMap.set(source.originalNumber, newNumber);

    return {
      number: newNumber,
      text: source.text
    };
  });

  const normalizedBody = body
    .replace(/\[(\d+)\]/g, (_, number) => {
      const mapped = renumberMap.get(Number(number));
      return mapped ? `[${mapped}]` : "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const sourcesSection = [
    "Sources:",
    ...normalizedSources.map((source) => `[${source.number}] ${source.text}`)
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

export default async function handler(req, res) {
  try {
    const incomingPrompt = req.body?.prompt || "";
    const company = req.body?.company || extractCompanyFromPrompt(incomingPrompt);
    const sanctionsResult = await getSanctionsScreening(company);
    const offshoreResult = await getOffshoreScreening(company);

    const promptWithScreening = [
      incomingPrompt,
      sanctionsResult,
      "Offshore Screening Result:",
      offshoreResult,
      "",
      "Include a dedicated report section titled 'Offshore Ownership Screening' based on the offshore screening result above.",
      "Use bracket citations in the report body only when a source is available, e.g. [1], [2].",
      "Always end the report with a section titled 'Sources:' and list every citation used in the body.",
      "Format the sources section exactly as numbered lines like:",
      "[1] Company official website",
      "[2] Government corporate registry",
      "[3] Business directories or listings",
      "[4] Public media sources",
      "Ensure citation numbers in the report body exactly match the listed source numbers.",
      "If reliable sources are unavailable, do not add citations and do not output a Sources section."
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

    res.status(200).json({
      result: formatReportWithSources(modelResult)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}