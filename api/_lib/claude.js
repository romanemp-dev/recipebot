// api/_lib/claude.js
// Вызов Anthropic API.
// Используется в /api/chat. Простая обёртка над fetch.

async function callClaude(systemPrompt, userMessage, maxTokens = 600) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.REACT_APP_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  const data = await response.json();
  if (!data.content || !data.content[0]) {
    throw new Error('Invalid API response: ' + JSON.stringify(data).substring(0, 200));
  }
  return data.content[0].text;
}

module.exports = { callClaude };
