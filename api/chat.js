export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { currentOutput, userMessage, hearingSheet } = body;
  if (!currentOutput || !userMessage) {
    return new Response(JSON.stringify({ error: '現在の出力と修正指示が必要です' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEYが設定されていません' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const systemPrompt = `あなたはLocaLinkの「Madoguchi」サービスにおけるInstagram初期構築の専門家です。
ユーザーから生成済みの成果物に対する修正指示を受けます。

## ルール
1. ユーザーの修正指示に正確に従い、現在の出力を修正してください
2. 修正箇所以外は一切変更せず、そのまま維持してください
3. **出力全文を返してください**（修正箇所だけでなく、全文をそのまま返す）
4. 余計な説明やコメントは不要です。修正後の成果物のみを出力してください
5. テンプレートの構造・形式は維持すること`;

  const messages = [];

  // Include original hearing sheet as context if available
  if (hearingSheet) {
    messages.push({
      role: 'user',
      content: `## ヒアリングシート全文\n\n${hearingSheet}\n\nこの情報を元に初期構築の成果物を生成してください。`
    });
  } else {
    messages.push({
      role: 'user',
      content: '初期構築の成果物を生成してください。'
    });
  }

  messages.push({
    role: 'assistant',
    content: currentOutput
  });

  messages.push({
    role: 'user',
    content: `以下の修正指示に従って、上記の成果物を修正してください。修正後の全文を出力してください。\n\n## 修正指示\n${userMessage}`
  });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16384,
        stream: true,
        system: systemPrompt,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const errorText = await anthropicRes.text();
      return new Response(JSON.stringify({ error: `Claude API error (${anthropicRes.status}): ${errorText}` }), {
        status: anthropicRes.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = anthropicRes.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (!data) continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`));
                }
              } catch (e) {
                // Skip non-JSON lines
              }
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`));
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
