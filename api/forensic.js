export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://api.perplexity.ai/chat/completions",
      {
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
              content: req.body.prompt
            }
          ]
        })
      }
    );

    const data = await response.json();

    res.status(200).json({
      result: data.choices?.[0]?.message?.content
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}