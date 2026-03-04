const OPEN_SANCTIONS_ENDPOINT = "https://api.opensanctions.org/match/default";
const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions";

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

export default async function handler(req, res) {
  try {
    const incomingPrompt = req.body?.prompt || "";
    const company = req.body?.company || extractCompanyFromPrompt(incomingPrompt);
    const sanctionsResult = await getSanctionsScreening(company);

    const promptWithScreening = `${incomingPrompt}\n\n${sanctionsResult}`;

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

    res.status(200).json({
      result: data.choices?.[0]?.message?.content
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}