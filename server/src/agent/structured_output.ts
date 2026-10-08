export function hasConfiguredModel(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.AWS_BEDROCK_MANTLE_KEY ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_REGION ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  );
}

export function parseStructuredJson(text: string): unknown {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  // Find balanced JSON objects/arrays while respecting quoted strings. This
  // handles prose containing braces better than a first/last-brace regex.
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{' || character === '[') {
        stack.push(character);
      } else if (character === '}' || character === ']') {
        const expected = character === '}' ? '{' : '[';
        if (stack[stack.length - 1] !== expected) break;
        stack.pop();
        if (stack.length === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function parseJsonValue(text: string): unknown {
  const parsed = parseStructuredJson(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}
