// Thin wrapper around the Anthropic SDK. If no credentials are configured the rest of
// the system keeps working with non-LLM fallbacks, and `status()` says why.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.LIFESTREAMS_MODEL || 'claude-opus-5-5';

let client = null;
let offline = null;

function init() {
  if (client || offline) return;
  const hasCreds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ||
    fs.existsSync(path.join(os.homedir(), '.config', 'anthropic'));
  if (!hasCreds) { offline = 'no Anthropic credentials (set ANTHROPIC_API_KEY)'; return; }
  try { client = new Anthropic(); } catch (e) { offline = e.message; }
}

export function status() {
  init();
  return { available: !!client, model: MODEL, reason: offline };
}

// One Messages API call. Returns the response, or throws with .offline set when the
// model can't be used so callers fall back.
export async function call({ system, messages, tools, effort = 'medium', max_tokens = 16000 }) {
  init();
  if (!client) throw Object.assign(new Error(offline), { offline: true });
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens,
      system,
      messages,
      ...(tools?.length ? { tools } : {}),
      output_config: { effort },
      // On a policy decline, let the API retry on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (res.stop_reason === 'refusal') throw Object.assign(new Error('the model declined this request'), { refusal: true });
    return res;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      client = null; offline = `authentication failed: ${e.message}`;
      throw Object.assign(new Error(offline), { offline: true });
    }
    throw e;
  }
}

// Manual tool loop: run until the model stops asking for tools or we hit maxSteps.
export async function runTools({ system, prompt, tools, execute, effort, maxSteps = 8 }) {
  const messages = [{ role: 'user', content: prompt }];
  for (let step = 0; ; step++) {
    const res = await call({ system, messages, tools: step < maxSteps ? tools : [], effort });
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const uses = res.content.filter(b => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) return text;
    messages.push({ role: 'assistant', content: res.content });
    const results = await Promise.all(uses.map(async u => {
      try {
        const out = await execute(u.name, u.input ?? {});
        return { type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: u.id, content: String(e.message || e), is_error: true };
      }
    }));
    messages.push({ role: 'user', content: results });
  }
}

export async function text({ system, prompt, effort = 'low', max_tokens = 8000 }) {
  const res = await call({ system, messages: [{ role: 'user', content: prompt }], effort, max_tokens });
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
