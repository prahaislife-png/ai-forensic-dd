async function collectEvidence(name, website) {
  const query = [name, website].filter(Boolean).join(" ").trim();

  if (!query || !process.env.SERPAPI_KEY) {
    return [];
  }

  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: "5",
    api_key: process.env.SERPAPI_KEY
  });

  const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`);

  if (!response.ok) {
    return [];
  }

  const data = await response.json();

  return (data?.organic_results || [])
    .slice(0, 5)
    .map((result) => ({
      title: result?.title || "",
      url: result?.link || "",
      snippet: result?.snippet || ""
    }))
    .filter((item) => item.url);
}

module.exports = { collectEvidence };